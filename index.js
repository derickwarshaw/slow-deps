#!/usr/bin/env node

'use strict'

if (!global.Promise) {
  global.Promise = require('lie')
}
var temp = require('temp')
var fs = require('fs')
var exec = require('child-process-promise').exec
var denodeify = require('denodeify')
var shellEscape = require('any-shell-escape')
var extend = require('js-extend').extend
var mkdir = denodeify(temp.mkdir)
var readFile = denodeify(fs.readFile)
var readdir = denodeify(fs.readdir)
var stat = denodeify(fs.stat)
var writeFile = denodeify(fs.writeFile)
var appendFile = denodeify(fs.appendFile)
var path = require('path')
var now = require('performance-now')
var ProgressBar = require('progress')
var getFolderSize = denodeify(require('get-folder-size'))
var prettierBytes = require('prettier-bytes')
var prettyMs = require('pretty-ms')
var tablify = require('tablify').tablify
var sum = require('math-sum')
var ncp = denodeify(require('ncp'))
var yargs = require('yargs')
temp.track()

var argv = yargs
  .usage('Usage: $0 [options]')

  .boolean('production')
  .describe('production', 'Skip devDependencies')
  .alias('production', 'prod')

  .boolean('no-optional')
  .describe('no-optional', 'Skip optionalDependencies')

  .boolean('no-shrinkwrap')
  .describe('no-shrinkwrap', 'Ignore npm-shrinkwrap.json')

  .example('$0', 'measure all deps in the current project')
  .example('$0 --production --no-optional', 'skip both optional and dev dependencies')

  .help('help')
  .alias('h', 'help')
  .argv

function formatPlural (num, strSingular, strPlural) {
  return num + ' ' + (num === 1 ? strSingular : strPlural)
}

function getDeps () {
  return readFile('package.json', 'utf8').then(function (str) {
    var pkgJson = JSON.parse(str)
    var deps = extend({}, pkgJson.dependencies)
    var devSkipped = 0
    var optionalSkipped = 0
    // Include devDependencies only if --production is absent
    if (!argv.production) {
      extend(deps, pkgJson.devDependencies)
    } else {
      devSkipped = Object.keys(pkgJson.devDependencies || {}).length
    }
    // Include optionalDependencies only if --no-optional argument is absent.
    // Note that yargs parses "--no-*" deps in a special way, hence this `!== false` check.
    if (argv.optional !== false) {
      extend(deps, pkgJson.optionalDependencies)
    } else {
      optionalSkipped = Object.keys(pkgJson.optionalDependencies || {}).length
    }
    var startMessage = 'Analyzing ' + Object.keys(deps).length + ' dependencies'
    if (devSkipped && optionalSkipped) {
      startMessage += ' (skipping ' + formatPlural(devSkipped, 'devDependency', 'devDependencies') +
        ' and ' + formatPlural(optionalSkipped, 'optionalDependency', 'optionalDependencies') + ')'
    } else if (devSkipped) {
      startMessage += ' (skipping ' + formatPlural(devSkipped, 'devDependency', 'devDependencies') + ')'
    } else if (optionalSkipped) {
      startMessage += ' (skipping ' + formatPlural(optionalSkipped, 'optionalDependency', 'optionalDependencies') + ')'
    }
    startMessage += '...'
    console.log(startMessage)
    return deps
  }).catch(function () {
    throw new Error('No package.json in the current directory.')
  })
}

function getShrinkwrapDeps () {
  var resolve = Promise.resolve({})
  return stat('npm-shrinkwrap.json').then(function (file) {
    if (argv.shrinkwrap !== false && file.isFile()) {
      return readFile('npm-shrinkwrap.json', 'utf8').then(function (str) {
        return JSON.parse(str).dependencies || {}
      }).catch(function () {
        return resolve
      })
    }
    return resolve
  }).catch(function () {
    return resolve
  })
}

function createEmptyNpmrc (dir) {
  return writeFile(path.join(dir, '.npmrc'), '', 'utf8')
}

function setupNpmrc (toDir) {
  // copy .npmrc from current directory if possible
  return stat('.npmrc').then(function (file) {
    if (file.isFile()) {
      return ncp('.npmrc', path.join(toDir, '.npmrc'))
    }
    return createEmptyNpmrc(toDir)
  }).catch(function () {
    return createEmptyNpmrc(toDir)
  })
}

function createNpmShrinkwrap (dir, dep) {
  return writeFile(path.join(dir, 'npm-shrinkwrap.json'), JSON.stringify(dep), 'utf8')
}

function createPackageJson (dir, dep, version) {
  var content = '{ "dependencies": { "' + dep + '": "' + version + '" } }'
  return writeFile(path.join(dir, 'package.json'), content, 'utf8')
}

function doNpmInstalls (deps, shrinkwrapDeps) {
  var promise = Promise.resolve()
  var bar = new ProgressBar('[:bar] :percent :etas', {
    total: Object.keys(deps).length,
    width: 20
  })
  var times = []

  function install (dep, version, dir) {
    var cache = path.join(dir, '.cache')
    var nodeModules = path.join(dir, 'node_modules')

    return setupNpmrc(dir).then(function () {
      // set the cache to a local cache directory
      return appendFile(path.join(dir, '.npmrc'), '\ncache=' + cache, 'utf8')
    }).then(function () {
      if (!shrinkwrapDeps[dep]) return Promise.resolve()
      return createNpmShrinkwrap(dir, shrinkwrapDeps[dep])
    }).then(function () {
      return createPackageJson(dir, dep, version)
    }).then(function () {
      var start = now()
      return exec(shellEscape([ 'npm', 'install' ]), {
        cwd: dir,
        env: process.env
      }).then(function () {
        var totalTime = now() - start
        return getFolderSize(nodeModules).then(function (size) {
          return readdir(nodeModules).then(function (subDeps) {
            times.push({
              time: totalTime,
              size: size,
              dep: dep,
              subDeps: subDeps.length - 1
            })
            bar.tick()
          })
        })
      })
    })
  }

  Object.keys(deps).forEach(function (dep) {
    var version = deps[dep]
    promise = promise.then(function () {
      return mkdir('')
    }).then(function (dir) {
      return install(dep, version, dir)
    })
  })
  return promise.then(function () {
    return report(times)
  })
}

function report (times) {
  times = times.sort(function (a, b) {
    return b.time - a.time
  })
  var header = ['Dependency', 'Time', 'Size', '# Deps']
  var table = [header].concat(times.map(function (time) {
    return [
      time.dep,
      prettyMs(time.time),
      prettierBytes(time.size),
      time.subDeps
    ]
  }))
  console.log(tablify(table, {
    show_index: false,
    has_header: true
  }))
  console.log('Total time (non-deduped): ' + prettyMs(sum(times.map(function (time) {
    return time.time
  }))))
  console.log('Total size (non-deduped): ' + prettierBytes(sum(times.map(function (time) {
    return time.size
  }))))
}

Promise.all([getDeps(), getShrinkwrapDeps()]).then(function (results) {
  var deps = results[0]
  var shrinkwrap = results[1]
  return doNpmInstalls(deps, shrinkwrap)
}).then(function () {
  process.exit(0)
}).catch(function (err) {
  console.error(err)
  console.error(err.stack)
  process.exit(1)
})
