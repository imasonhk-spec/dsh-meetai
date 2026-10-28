// Operational identity pins from the existing formal service and prior real-model verification.
// These are NOT legacy release/quality/performance acceptance certificates.
export const LOCAL_SERVICE = Object.freeze({
  host:'127.0.0.1',port:11435,upstreamPort:11439,upstreamUid:0,nativeVersion:'0.32.13',
  proxyScript:'/home/lgsj/dsh-ollama-shim/index.js',
  proxySha256:'44ca576bdbc8e4c5c02f77fe49ed577c012d89296e2daff0a13b1637bbfa102e',
  executable:'/usr/local/node/bin/node',
  executableSha256:'b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd',
  contextWindow:32768,
});
export const LOCAL_MODELS = Object.freeze({
  'huiwen-max:latest':Object.freeze({
    digest:'97846afeee3f132a2eaea4c630ab65260e26bbeeef801045e8012cc5a6db8e8a',
    weightsSha256:'93c83617a40560a61cda911ee327efdb5b5fbd39caa8b777a4ec565c0af1af3d',
    parameterSize:'125.1B',quantization:'Q4_K_M',family:'qwen35moe',
    templateSha256:'b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315',
  }),
  'huiwen-luna:latest':Object.freeze({
    digest:'389a3963fd12972de019a6df3a1dce3f4fdd839cc4b1ff182e677f1f0c0e228a',
    weightsSha256:'f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d',
    parameterSize:'36.0B',quantization:'Q4_K_M',family:'qwen35moe',
    templateSha256:'2d54db2b9bb29ce7db54fea63a891f5859603813c555b1f88b5e0994652897f9',
  }),
});
