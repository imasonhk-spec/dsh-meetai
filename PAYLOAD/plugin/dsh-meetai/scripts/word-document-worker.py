#!/usr/bin/python3
"""Private server-side, single-request JSON RPC. Never invoke with client-supplied paths."""
import copy
import ctypes
import ctypes.util
import errno
import hashlib
import json
import os
import posixpath
from urllib.parse import unquote
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
XMLSPACE = '{http://www.w3.org/XML/1998/namespace}space'
MAX_ZIP = 30 * 1024 * 1024
MAX_EXPANDED = 80 * 1024 * 1024
MAX_ENTRIES = 1500
MAX_XML = 12 * 1024 * 1024
REFERENCE_SHA = '39295aa7a97555da84a6dc9a10c77811fdf8853bb706af95b391e91355489b18'
DEFAULT = Path(__file__).with_name('default-minutes-template.docx')

class WorkerError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

def fail(code, message):
    raise WorkerError(code, message)

def path_arg(value, root=None, suffix=None, exists=False):
    if not isinstance(value, str) or not value or '\x00' in value:
        fail('INVALID_PATH', 'A private server path is required.')
    p = Path(value).expanduser().resolve()
    if root:
        r = Path(root).resolve()
        if not p.is_relative_to(r):
            fail('PATH_OUTSIDE_ROOT', 'Path is outside the private parent root.')
    if suffix and p.suffix.lower() != suffix:
        fail('UNSUPPORTED_TYPE', 'Only DOCX documents are accepted.')
    if exists and not p.is_file():
        fail('INPUT_NOT_FOUND', 'Input document does not exist.')
    return p

def xml_parse(data):
    if len(data) > MAX_XML:
        fail('ZIP_LIMIT', 'XML part exceeds safety limits.')
    if re.search(br'<!\s*(DOCTYPE|ENTITY)', data, re.I):
        fail('UNSAFE_XML', 'DTD and entities are forbidden.')
    try:
        return ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True,
                                               load_dtd=False, huge_tree=False))
    except ET.XMLSyntaxError:
        fail('INVALID_XML', 'Document contains malformed XML.')

def package(p):
    if p.stat().st_size > MAX_ZIP:
        fail('ZIP_LIMIT', 'Compressed document exceeds safety limits.')
    try:
        with zipfile.ZipFile(p) as z:
            infos = z.infolist()
            if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_EXPANDED:
                fail('ZIP_LIMIT', 'Expanded document exceeds safety limits.')
            seen = set()
            for i in infos:
                n = i.filename
                if n in seen or '\\' in n or n.startswith('/') or ':' in n or '..' in PurePosixPath(n).parts:
                    fail('UNSAFE_ZIP_PATH', 'Unsafe or duplicate package entry.')
                seen.add(n)
                if i.flag_bits & 1:
                    fail('ENCRYPTED_DOCX', 'Encrypted documents are not supported.')
                if i.file_size > MAX_EXPANDED or (i.file_size > 1024 * 1024 and i.file_size > max(i.compress_size, 1) * 200):
                    fail('ZIP_LIMIT', 'Package compression ratio exceeds safety limits.')
                if (i.external_attr >> 16) & 0o170000 == 0o120000:
                    fail('UNSAFE_ZIP_PATH', 'Symlink package entries are forbidden.')
                if any(s in n.lower() for s in ('vbaproject', 'activex/', 'embeddings/')):
                    fail('ACTIVE_CONTENT', 'Macros and embedded active content are forbidden.')
            if '[Content_Types].xml' not in seen or 'word/document.xml' not in seen:
                fail('UNSUPPORTED_TYPE', 'Input is not an OOXML Word document.')
            data = {i.filename: z.read(i) for i in infos}
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError):
        fail('INVALID_ZIP', 'Invalid or unsupported DOCX archive.')
    trees = {}
    for name, raw in data.items():
        if name.lower().endswith(('.xml', '.rels')):
            tree = xml_parse(raw)
            trees[name] = tree
            if name.lower().endswith('.rels'):
                for rel in tree:
                    target = unquote(rel.get('Target', ''))
                    if rel.get('TargetMode', '').lower() == 'external' or re.match(r'^[a-zA-Z][\w+.-]*:', target):
                        fail('EXTERNAL_RELATIONSHIP', 'External relationships are forbidden, including hyperlinks.')
                    if '\\' in target or target.startswith('//') or '\x00' in target:
                        fail('UNSAFE_RELATIONSHIP', 'Unsafe relationship target.')
                    base = str(PurePosixPath(name).parent.parent)
                    normalized = posixpath.normpath(posixpath.join(base, target))
                    if normalized == '..' or normalized.startswith('../'):
                        fail('UNSAFE_RELATIONSHIP', 'Relationship escapes the document package.')
            if name == '[Content_Types].xml':
                main = [x.get('ContentType', '') for x in tree if x.get('PartName') == '/word/document.xml']
                if main != ['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']:
                    fail('UNSUPPORTED_TYPE', 'Only macro-free DOCX content type is accepted.')
            if name.startswith('word/'):
                if tree.xpath('//w:object | //w:altChunk', namespaces=NS):
                    fail('ACTIVE_CONTENT', 'Objects and imported executable content are forbidden.')
                instructions = ' '.join(tree.xpath('//w:instrText/text()', namespaces=NS) + tree.xpath('//w:fldSimple/@w:instr', namespaces=NS))
                if re.search(r'\b(INCLUDETEXT|INCLUDEPICTURE|DDE|DDEAUTO|LINK|DATABASE)\b', instructions, re.I):
                    fail('ACTIVE_CONTENT', 'External or active fields are forbidden.')
    document = trees.get('word/document.xml')
    if document is None or document.tag != '{%s}document' % W or document.find('{%s}body' % W) is None:
        fail('UNSUPPORTED_TYPE', 'Missing Word document body.')
    return data, trees

def stories(trees):
    return sorted(n for n in trees if n == 'word/document.xml' or re.fullmatch(r'word/(header|footer)\d+\.xml', n))

def paragraphs(trees):
    out = {}
    for name in stories(trees):
        for i, p in enumerate(trees[name].iter('{%s}p' % W)):
            out[f'{name}#p{i}'] = (name, p)
    return out

def atoms(p):
    result = []
    for node in p.iter():
        if node.tag not in ('{%s}t' % W, '{%s}br' % W, '{%s}tab' % W):
            continue
        nearest = next((a for a in node.iterancestors() if a.tag == '{%s}p' % W), None)
        if nearest is not p: continue
        value = node.text or '' if node.tag == '{%s}t' % W else ('\t' if node.tag == '{%s}tab' % W else '\n')
        result.append((node, value))
    return result

def text(p):
    return ''.join(value for _, value in atoms(p))

def expand_breaks(node):
    value = (node.text or '').replace('\r\n', '\n').replace('\r', '\n')
    if '\n' not in value and '\t' not in value: return
    parent = node.getparent()
    index = parent.index(node)
    for item in re.split(r'([\n\t])', value):
        tag = 'br' if item == '\n' else 'tab' if item == '\t' else 't'
        new = ET.Element('{%s}%s' % (W, tag))
        if tag == 't':
            new.text = item
            new.set(XMLSPACE, 'preserve')
        parent.insert(index, new)
        index += 1
    parent.remove(node)

def font_report(trees):
    fonts = set()
    for tree in trees.values():
        for node in tree.iter('{%s}rFonts' % W):
            for key in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
                v = node.get('{%s}%s' % (W, key))
                if v: fonts.add(v)
        for node in tree.iter('{%s}font' % W):
            if node.get('{%s}name' % W): fonts.add(node.get('{%s}name' % W))
    warnings = ['Preview uses LibreOffice pagination, not exact Microsoft Word native layout.']
    installed = set()
    try:
        r = subprocess.run(['/usr/bin/fc-list', '--format=%{family}\n'], capture_output=True, text=True, timeout=5)
        installed = {f.strip().casefold() for line in r.stdout.splitlines() for f in line.split(',')}
    except (OSError, subprocess.TimeoutExpired):
        warnings.append('Font availability could not be checked.')
    missing = sorted(f for f in fonts if f.casefold() not in installed)
    if missing:
        warnings.append('Configured fonts are not installed and may be substituted: ' + ', '.join(missing))
    return {'fonts': sorted(fonts), 'missingFonts': missing, 'warnings': warnings}

M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

def math_text(node):
    """Linear OMML for indexing only; never rebuild the authoritative DOCX."""
    local = ET.QName(node).localname
    children = {ET.QName(c).localname: c for c in node}
    def value(key):
        return math_text(children[key]) if key in children else ''
    if local == 't': return node.text or ''
    if local.endswith('Pr'): return ''
    if local == 'f': return '(' + value('num') + ')/(' + value('den') + ')'
    if local == 'sSup': return value('e') + '^(' + value('sup') + ')'
    if local == 'sSub': return value('e') + '_(' + value('sub') + ')'
    if local == 'sSubSup': return value('e') + '_(' + value('sub') + ')^(' + value('sup') + ')'
    if local == 'rad': return 'root(' + value('deg') + ';' + value('e') + ')'
    if local == 'sPre': return '_(' + value('sub') + ')^(' + value('sup') + ')' + value('e')
    if local in ('limLow', 'limUpp'): return value('e') + ('_(' if local == 'limLow' else '^(') + value('lim') + ')'
    if local == 'func': return value('fName') + '(' + value('e') + ')'
    if local == 'eqArr': return '{' + '; '.join(math_text(c) for c in node if ET.QName(c).localname == 'e') + '}'
    if local in ('acc', 'bar', 'groupChr'):
        prop = children.get(local + 'Pr')
        mark = prop.find('{%s}chr' % M) if prop is not None else None
        char = mark.get('{%s}val' % M, '') if mark is not None else ''
        return local + '[' + char + '](' + value('e') + ')'
    if local in ('d', 'nary'):
        prop = children.get(local + 'Pr')
        def setting(key, default):
            item = prop.find('{%s}%s' % (M, key)) if prop is not None else None
            return item.get('{%s}val' % M, default) if item is not None else default
        if local == 'd':
            return setting('begChr', '(') + setting('sepChr', '|').join(math_text(c) for c in node if ET.QName(c).localname == 'e') + setting('endChr', ')')
        return setting('chr', '∫') + ('_(' + value('sub') + ')' if value('sub') else '') + ('^(' + value('sup') + ')' if value('sup') else '') + value('e')
    if local == 'm': return '[' + '; '.join(math_text(c) for c in node if ET.QName(c).localname == 'mr') + ']'
    if local == 'mr': return ', '.join(math_text(c) for c in node if ET.QName(c).localname == 'e')
    return ''.join(math_text(c) for c in node)

def indexed_content(trees):
    # Literal text: do not strip factual Markdown-like operators or underscores.
    parts = stories(trees) + sorted(n for n in trees if n in ('word/footnotes.xml', 'word/endnotes.xml'))
    lines = []
    for part in parts:
        for para in trees[part].iter('{%s}p' % W):
            values = []
            def visit(node):
                if node is not para and node.tag == '{%s}p' % W: return
                if node.tag in ('{%s}del' % W, '{%s}moveFrom' % W): return
                if node.tag == '{%s}oMath' % M:
                    values.append(math_text(node)); return
                if node.tag == '{%s}t' % W: values.append(node.text or '')
                elif node.tag == '{%s}tab' % W: values.append('\t')
                elif node.tag in ('{%s}br' % W, '{%s}cr' % W): values.append('\n')
                elif node.tag == '{%s}noBreakHyphen' % W: values.append('\u2011')
                elif node.tag == '{%s}softHyphen' % W: values.append('\u00ad')
                for child in node: visit(child)
            visit(para)
            lines.append(''.join(values))
    content = '\n'.join(lines)
    if len(content) > 500000: fail('WORD_CONTENT_INVALID', 'Extracted text exceeds indexing limits.')
    return content

def inspect(p):
    _, trees = package(p)
    blocks = []
    for pid, (part, para) in paragraphs(trees).items():
        blocks.append({'paragraphId': pid, 'text': text(para), 'part': part,
                       'kind': 'table' if any(a.tag == '{%s}tc' % W for a in para.iterancestors()) else 'paragraph'})
    return {'blocks': blocks, 'content': indexed_content(trees), 'sha256': digest(p), **font_report(trees)}

def literal_replace(p, needle, value):
    # Use the same text addressing as inspect/validation, including tabs/breaks
    # and excluding paragraphs nested inside drawing/textbox descendants.
    segments = atoms(p)
    full = ''.join(old for _, old in segments)
    if full.count(needle) != 1:
        fail('PLACEHOLDER_OCCURRENCE', 'Each fill must match exactly one literal occurrence in its paragraph.')
    start, end = full.index(needle), full.index(needle) + len(needle)
    pos, inserted = 0, False
    changed = []
    for node, old in segments:
        a, b = pos, pos + len(old)
        if a < end and b > start:
            prefix = old[:max(0, start-a)]
            suffix = old[max(0, end-a):]
            replacement = prefix + (value if not inserted else '') + suffix
            if node.tag == '{%s}t' % W:
                node.text = replacement
                node.set(XMLSPACE, 'preserve')
                changed.append(node)
            else:
                parent = node.getparent()
                if replacement:
                    new = ET.Element('{%s}t' % W)
                    new.text = replacement
                    new.set(XMLSPACE, 'preserve')
                    parent.insert(parent.index(node), new)
                    changed.append(new)
                parent.remove(node)
            inserted = True
        pos = b
    # OOXML requires actual w:br/w:tab nodes, not newline literals inside w:t.
    for node in changed:
        expand_breaks(node)

def clean_line(line):
    line = re.sub(r'^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)', '', line)
    line = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', line)
    # Remove paired Markdown decoration only; keep factual underscores/operators.
    line = re.sub(r'\*\*([^*\n]+)\*\*', r'\1', line)
    line = re.sub(r'__([^_\n]+)__', r'\1', line)
    line = re.sub(r'`([^`\n]+)`', r'\1', line)
    line = re.sub(r'(?<!\w)\*([^*\n]+)\*(?!\w)', r'\1', line)
    return line.strip()

def role_clone(source, value):
    p = ET.Element('{%s}p' % W)
    prop = source.find('w:pPr', NS)
    if prop is not None: p.append(copy.deepcopy(prop))
    r = ET.SubElement(p, '{%s}r' % W)
    rp = source.find('w:r/w:rPr', NS)
    if rp is not None: r.append(copy.deepcopy(rp))
    t = ET.SubElement(r, '{%s}t' % W)
    t.set(XMLSPACE, 'preserve')
    t.text = value
    return p

def default_content(trees, content):
    if not isinstance(content, str) or not content.strip() or len(content) > 500000:
        fail('INVALID_CONTENT', 'Nonempty generated minutes text is required.')
    body = trees['word/document.xml'].find('w:body', NS)
    ref = list(body.findall('w:p', NS))
    if len(ref) < 37: fail('INVALID_DEFAULT', 'Trusted style reference is incomplete.')
    roles = {'title': ref[3], 'agency': ref[1], 'body': ref[5], 'topic': ref[6], 'footer': ref[35]}
    lines = [(s, clean_line(s)) for s in content.splitlines() if clean_line(s) and not re.fullmatch(r'\s*[-*_]{3,}\s*', s)]
    if not lines: fail('INVALID_CONTENT', 'Generated minutes text contains no content.')
    section = body.find('w:sectPr', NS)
    for child in list(body):
        if child is not section: body.remove(child)
    for i, (raw, value) in enumerate(lines):
        role = 'title' if i == 0 else 'body'
        if re.match(r'^\s*#\s', raw): role = 'title'
        elif re.match(r'^\s*#{2,6}\s', raw) or re.match(r'^[一二三四五六七八九十]+、', value): role = 'topic'
        elif value.endswith('会议纪要'): role = 'title'
        if value.startswith(('分送：', '抄送：', '印发：')): role = 'footer'
        if value.startswith(('发文单位：', '编制单位：', '深圳市龙岗区人民政府办公室')):
            role = 'footer' if value.endswith('印发') else 'agency'
        p = role_clone(roles[role], value)
        if section is None: body.append(p)
        else: body.insert(body.index(section), p)
    # Reference header/footer may contain example facts. Preserve formatting and page fields, not example text.
    for name in stories(trees):
        if name != 'word/document.xml':
            for t in trees[name].iter('{%s}t' % W): t.text = ''
    for name in ('docProps/core.xml', 'docProps/app.xml'):
        if name in trees:
            for node in trees[name].iter():
                if len(node) == 0 and node.text: node.text = ''

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def render(req):
    mode = req.get('mode')
    if mode not in ('fills', 'default'): fail('INVALID_MODE', 'Mode must be fills or default.')
    source = DEFAULT if mode == 'default' else path_arg(req.get('input'), req.get('root'), '.docx', True)
    if mode == 'default' and digest(source) != REFERENCE_SHA:
        fail('INVALID_DEFAULT', 'Trusted default reference hash mismatch.')
    output = path_arg(req.get('output'), req.get('root'), '.docx')
    if source == output: fail('INVALID_PATH', 'Input and output must differ.')
    data, trees = package(source)
    changed = set()
    count = 0
    if mode == 'default':
        default_content(trees, req.get('content'))
        changed = set(stories(trees)) | {'docProps/core.xml', 'docProps/app.xml'}
    else:
        fills = req.get('fills')
        if not isinstance(fills, list) or not fills or len(fills) > 2000:
            fail('EMPTY_FILLS', 'A nonempty validated fill plan is required.')
        ps = paragraphs(trees)
        seen = set()
        # Validate entire plan against original document before mutation; forbid overlap.
        intervals = {}
        for f in fills:
            if not isinstance(f, dict): fail('INVALID_FILL', 'Invalid fill entry.')
            pid, needle, val = f.get('paragraphId'), f.get('placeholder'), f.get('value')
            if not isinstance(pid, str) or pid not in ps: fail('INVALID_PARAGRAPH', 'Unknown paragraph ID.')
            if not isinstance(needle, str) or not needle or len(needle) > 10000 or not isinstance(val, str) or not val.strip() or len(val) > 500000:
                fail('INVALID_FILL', 'Nonempty literal placeholder and nonempty replacement text required.')
            if val == needle or any(ord(c) < 32 and c not in '\t\n\r' for c in val):
                fail('INVALID_FILL', 'Fill must change the placeholder and contain valid XML text.')
            if (pid, needle) in seen: fail('DUPLICATE_FILL', 'Duplicate fill entry.')
            seen.add((pid, needle))
            full = text(ps[pid][1])
            if full.count(needle) != 1: fail('PLACEHOLDER_OCCURRENCE', 'Each fill must match exactly one literal occurrence in its paragraph.')
            a, b = full.index(needle), full.index(needle) + len(needle)
            if any(a < y and b > x for x, y in intervals.get(pid, [])):
                fail('OVERLAPPING_FILLS', 'Placeholder spans overlap.')
            intervals.setdefault(pid, []).append((a, b))
        # Descending positions prevents one replacement from changing subsequent literal addresses.
        ordered = sorted(fills, key=lambda f: (f['paragraphId'], text(ps[f['paragraphId']][1]).index(f['placeholder'])), reverse=True)
        for f in ordered:
            name, p = ps[f['paragraphId']]
            literal_replace(p, f['placeholder'], f['value'])
            changed.add(name)
            count += 1
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.word-', suffix='.docx', dir=output.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, raw in data.items():
                if name in changed and name in trees:
                    raw = ET.tostring(trees[name], xml_declaration=True, encoding='UTF-8', standalone=True)
                z.writestr(name, raw)
        package(Path(tmp))
        os.replace(tmp, output)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return {'docxPath': str(output), 'sha256': digest(output), 'filledCount': count,
            **font_report(trees)}

def deny_network():
    """Pre-exec seccomp filter inherited by LO and all its descendants."""
    lib = ctypes.CDLL(ctypes.util.find_library('seccomp') or 'libseccomp.so.2')
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    class ArgCmp(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                    ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                          ctypes.c_uint, ctypes.POINTER(ArgCmp)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx: os._exit(125)
    # LO needs local AF_UNIX IPC. Forbid every other socket family (including
    # IPv4, IPv6, packet and netlink). Popen closes inherited non-stdio FDs.
    comparison = ArgCmp(0, 1, 1, 0)  # arg0 != AF_UNIX; SCMP_CMP_NE = 1
    for name in (b'socket', b'socketpair'):
        nr = lib.seccomp_syscall_resolve_name(name)
        if nr >= 0 and lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM, nr, 1, ctypes.byref(comparison)) != 0:
            os._exit(125)
    if lib.seccomp_load(ctx) != 0: os._exit(125)
    lib.seccomp_release(ctx)

def preview(req):
    p = path_arg(req.get('input'), req.get('root'), '.docx', True)
    _, trees = package(p)
    if not Path('/usr/bin/libreoffice').is_file(): fail('PREVIEW_UNAVAILABLE', 'LibreOffice is unavailable.')
    if not ctypes.util.find_library('seccomp'): fail('PREVIEW_SANDBOX_UNAVAILABLE', 'Network-denying seccomp is unavailable.')
    work = path_arg(req.get('workdir'), req.get('root'))
    work.mkdir(parents=True, exist_ok=True)
    isolated = Path(tempfile.mkdtemp(prefix='word-preview-', dir=work))
    profile = isolated / 'profile'
    profile.mkdir()
    # Disable macros and all link updating explicitly in the isolated profile.
    (profile / 'user').mkdir()
    (profile / 'user/registrymodifications.xcu').write_text('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>''')
    env = dict(os.environ, HOME=str(isolated), TMPDIR=str(isolated), SAL_USE_VCLPLUGIN='svp')
    try:
        try:
            proc = subprocess.Popen(['/usr/bin/libreoffice', '-env:UserInstallation=' + profile.as_uri(),
                    '--headless', '--nologo', '--nodefault', '--norestore', '--nolockcheck',
                    '--convert-to', 'pdf:writer_pdf_Export', '--outdir', str(isolated), str(p)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                    preexec_fn=deny_network, start_new_session=os.environ.get('DSH_WORD_WORKER_PG') != '1', close_fds=True)
            try:
                proc.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpid() if os.environ.get('DSH_WORD_WORKER_PG') == '1' else proc.pid, signal.SIGKILL)
                proc.communicate()
                fail('PREVIEW_TIMEOUT', 'LibreOffice conversion exceeded the time limit.')
        except subprocess.TimeoutExpired:
            fail('PREVIEW_TIMEOUT', 'LibreOffice conversion exceeded the time limit.')
        except (OSError, subprocess.SubprocessError):
            fail('PREVIEW_FAILED', 'Sandboxed preview could not start.')
        pdf = isolated / (p.stem + '.pdf')
        if proc.returncode or not pdf.is_file() or pdf.read_bytes()[:5] != b'%PDF-':
            fail('PREVIEW_FAILED', 'LibreOffice did not produce a valid PDF.')
        final = work / ('preview-' + digest(p)[:24] + '.pdf')
        os.replace(pdf, final)
        pages = None
        try:
            info = subprocess.run(['/usr/bin/pdfinfo', str(final)], capture_output=True, text=True, timeout=10)
            match = re.search(r'^Pages:\s+(\d+)', info.stdout, re.M)
            if match: pages = int(match.group(1))
        except (OSError, subprocess.TimeoutExpired): pass
        return {'pdfPath': str(final), 'sha256': digest(final), 'docxSha256': digest(p), 'pages': pages,
                'paginationEngine': 'LibreOffice', 'networkDenied': True, **font_report(trees)}
    finally:
        shutil.rmtree(isolated, ignore_errors=True)

def main():
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024: fail('REQUEST_LIMIT', 'RPC request is too large.')
        try: req = json.loads(raw)
        except (ValueError, UnicodeError): fail('INVALID_REQUEST', 'Expected one JSON request.')
        if not isinstance(req, dict): fail('INVALID_REQUEST', 'Expected an object request.')
        op = req.get('op')
        if op == 'inspect': result = inspect(path_arg(req.get('input'), req.get('root'), '.docx', True))
        elif op == 'render': result = render(req)
        elif op == 'preview': result = preview(req)
        else: fail('INVALID_OPERATION', 'Operation must be inspect, render or preview.')
        result = {'ok': True, **result}
    except WorkerError as e:
        result = {'ok': False, 'error': {'code': e.code, 'message': e.message}}
    except Exception:
        result = {'ok': False, 'error': {'code': 'INTERNAL_ERROR', 'message': 'Document processing failed.'}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')

if __name__ == '__main__': main()
