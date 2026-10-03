// 测试运行器：把 '@/…' 解析到编译产物的 src 目录，然后执行测试入口。
const path = require('path')
const Module = require('module')

const buildRoot = __dirname
const original = Module._resolveFilename
Module._resolveFilename = function resolve(request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(buildRoot, 'src', request.slice(2))
  }
  return original.call(this, request, ...rest)
}

require(path.join(buildRoot, 'tests', 'plan-snapshots.test.js'))
