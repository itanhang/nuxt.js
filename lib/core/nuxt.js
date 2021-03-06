import Module from 'module'
import { resolve, join } from 'path'

import enableDestroy from 'server-destroy'
import _ from 'lodash'
import fs from 'fs-extra'
import consola from 'consola'
import chalk from 'chalk'
import esm from 'esm'
import ip from 'ip'

import Options from '../common/options'
import { sequence } from '../common/utils'
import packageJSON from '../../package.json'

import ModuleContainer from './module'
import Renderer from './renderer'

export default class Nuxt {
  constructor(options = {}) {
    this.options = Options.from(options)

    this.readyMessage = null
    this.initialized = false

    // Hooks
    this._hooks = {}
    this.hook = this.hook.bind(this)

    // Create instance of core components
    this.moduleContainer = new ModuleContainer(this)
    this.renderer = new Renderer(this)

    // Backward compatibility
    this.render = this.renderer.app
    this.renderRoute = this.renderer.renderRoute.bind(this.renderer)
    this.renderAndGetWindow = this.renderer.renderAndGetWindow.bind(
      this.renderer
    )
    this.resolvePath = this.resolvePath.bind(this)
    this.resolveAlias = this.resolveAlias.bind(this)

    // ESM Loader
    this.esm = esm(module, {})

    this._ready = this.ready().catch((err) => {
      consola.fatal(err)
    })
  }

  static get version() {
    return packageJSON.version
  }

  async ready() {
    if (this._ready) {
      return this._ready
    }

    // Add hooks
    if (_.isPlainObject(this.options.hooks)) {
      this.addObjectHooks(this.options.hooks)
    } else if (typeof this.options.hooks === 'function') {
      this.options.hooks(this.hook)
    }

    // Await for modules
    await this.moduleContainer.ready()

    // Await for renderer to be ready
    await this.renderer.ready()

    this.initialized = true

    // Call ready hook
    await this.callHook('ready', this)

    return this
  }

  hook(name, fn) {
    if (!name || typeof fn !== 'function') {
      return
    }
    this._hooks[name] = this._hooks[name] || []
    this._hooks[name].push(fn)
  }

  async callHook(name, ...args) {
    if (!this._hooks[name]) {
      return
    }
    consola.debug(`Call ${name} hooks (${this._hooks[name].length})`)
    try {
      await sequence(this._hooks[name], fn => fn(...args))
    } catch (err) {
      consola.error(err)
      this.callHook('error', err)
    }
  }

  addObjectHooks(hooksObj) {
    Object.keys(hooksObj).forEach((name) => {
      let hooks = hooksObj[name]
      hooks = Array.isArray(hooks) ? hooks : [hooks]
      hooks.forEach(hook => this.hook(name, hook))
    })
  }

  showReady(clear = true) {
    if (!this.readyMessage) {
      return
    }
    consola.ready({
      message: this.readyMessage,
      badge: true,
      clear
    })
  }

  listen(port = 3000, host = 'localhost') {
    return this.ready().then(() => new Promise((resolve, reject) => {
      const server = this.renderer.app.listen(
        { port, host, exclusive: false },
        (err) => {
          /* istanbul ignore if */
          if (err) {
            return reject(err)
          }

          ({ address: host, port } = server.address())
          if (host === '127.0.0.1') {
            host = 'localhost'
          } else if (host === '0.0.0.0') {
            host = ip.address()
          }

          const listenURL = chalk.underline.blue(`http://${host}:${port}`)
          this.readyMessage = `Listening on ${listenURL}`

          // Close server on nuxt close
          this.hook(
            'close',
            () =>
              new Promise((resolve, reject) => {
                // Destroy server by forcing every connection to be closed
                server.destroy((err) => {
                  consola.debug('server closed')
                  /* istanbul ignore if */
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              })
          )

          this.callHook('listen', server, { port, host }).then(resolve)
        }
      )

      // Add server.destroy(cb) method
      enableDestroy(server)
    }))
  }

  resolveModule(path) {
    try {
      const resolvedPath = Module._resolveFilename(path, {
        paths: this.options.modulesDir
      })

      return resolvedPath
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        return null
      } else {
        throw error
      }
    }
  }

  resolveAlias(path) {
    const modulePath = this.resolveModule(path)

    // Try to resolve it as if it were a regular node_module
    // Package first. Fixes issue with @<org> scoped packages
    if (modulePath != null) {
      return modulePath
    }

    if (path.indexOf('@@') === 0 || path.indexOf('~~') === 0) {
      return join(this.options.rootDir, path.substr(2))
    }

    if (path.indexOf('@') === 0 || path.indexOf('~') === 0) {
      return join(this.options.srcDir, path.substr(1))
    }

    return resolve(this.options.srcDir, path)
  }

  resolvePath(path) {
    const _path = this.resolveAlias(path)

    if (fs.existsSync(_path)) {
      return _path
    }

    for (const ext of this.options.extensions) {
      if (fs.existsSync(_path + '.' + ext)) {
        return _path + '.' + ext
      }
    }

    throw new Error(`Cannot resolve "${path}" from "${_path}"`)
  }

  requireModule(_path, opts = {}) {
    const _resolvedPath = this.resolvePath(_path)
    const m = opts.esm === false ? require(_resolvedPath) : this.esm(_resolvedPath)
    return (m && m.default) || m
  }

  async close(callback) {
    await this.callHook('close', this)

    /* istanbul ignore if */
    if (typeof callback === 'function') {
      await callback()
    }
  }
}
