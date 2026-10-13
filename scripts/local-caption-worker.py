#!/usr/bin/env python3
"""Fixed local-only PCM preview worker; JSON-lines stdin/stdout, never a hub client."""
import contextlib
import ctypes
import errno
import json
import os
from pathlib import Path
import sys

RUNTIME = Path('/home/lgsj/Downloads/AI game/akun-meeting/akun-runtime')
MODELS = RUNTIME / 'release/models'
REQUIRED = {
    'paraformer': ('config.yaml', 'model.pt', 'tokens.json', 'seg_dict', 'am.mvn'),
    'punc': ('config.yaml', 'model.pt', 'tokens.json'),
}


def block_network():
    # Kernel-enforced, process-local, inherited by threads. No host firewall changes.
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError('network isolation unavailable')
    try:
        for name in (b'socket', b'socketpair', b'connect', b'sendto', b'sendmsg', b'sendmmsg', b'io_uring_setup'):
            nr = lib.seccomp_syscall_resolve_name(name)
            if nr >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, nr, 0) != 0:
                raise RuntimeError('network isolation unavailable')
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError('network isolation unavailable')
    finally:
        lib.seccomp_release(ctx)


def verify_models():
    for model, names in REQUIRED.items():
        folder = MODELS / model
        if folder.is_symlink() or not folder.is_dir():
            raise RuntimeError('local model unavailable')
        for name in names:
            p = folder / name
            if p.is_symlink() or not p.is_file() or p.stat().st_size == 0:
                raise RuntimeError('local model unavailable')


def load_model(folder, AutoModel, yaml):
    # model_conf skips FunASR download_model, including configuration.json hub aliases.
    with (folder / 'config.yaml').open(encoding='utf8') as f:
        config = yaml.safe_load(f)
    config['init_param'] = str(folder / 'model.pt')
    config.setdefault('tokenizer_conf', {})['token_list'] = str(folder / 'tokens.json')
    if folder.name == 'paraformer':
        config['tokenizer_conf']['seg_dict_file'] = str(folder / 'seg_dict')
        config.setdefault('frontend_conf', {})['cmvn_file'] = str(folder / 'am.mvn')
    for key in ('vad_model', 'punc_model', 'spk_model', 'lm_model', 'remote_code'):
        config.pop(key, None)
    config.update(device='cpu', ngpu=0, ncpu=3, disable_update=True,
                  disable_pbar=True, disable_log=True, trust_remote_code=False)
    return AutoModel(**config)


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    block_network()
    import socket
    try:
        socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        raise RuntimeError('network isolation failed')
    for key, value in {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                       'MODELSCOPE_OFFLINE': '1', 'CUDA_VISIBLE_DEVICES': '',
                       'OMP_NUM_THREADS': '3', 'MKL_NUM_THREADS': '3'}.items():
        os.environ[key] = value
    verify_models()
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        import numpy as np
        import torch
        import yaml
        from funasr import AutoModel
        torch.set_num_threads(3)
        torch.set_num_interop_threads(2)
        asr = load_model(MODELS / 'paraformer', AutoModel, yaml)
        punc = load_model(MODELS / 'punc', AutoModel, yaml)
    emit({'state': 'ready', 'networkBlocked': True, 'device': 'cpu'})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            seq = request['seq']
            if type(seq) is not int or seq < 0 or seq > 100000:
                raise ValueError('sequence')
            # Fixed private-cwd filenames, no client-supplied filesystem paths.
            p = Path.cwd() / f'chunk-{seq}.pcm'
            if p.is_symlink() or not p.is_file():
                raise ValueError('payload')
            raw = p.read_bytes()
            if len(raw) < 3200 or len(raw) > 960000 or len(raw) % 2:
                raise ValueError('payload')
            samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
            if not np.isfinite(samples).all():
                raise ValueError('payload')
            with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink), torch.inference_mode():
                result = asr.generate(input=samples, fs=16000, batch_size=1)
                text = str(result[0].get('text', '')) if result else ''
                if text.strip():
                    punctuated = punc.generate(input=text)
                    if punctuated:
                        text = str(punctuated[0].get('text', text))
            emit({'seq': seq, 'text': text[:10000]})
        except Exception:
            emit({'error': 'LOCAL_INFERENCE_FAILED'})
            return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        emit({'error': 'LOCAL_WORKER_UNAVAILABLE'})
        sys.exit(1)
