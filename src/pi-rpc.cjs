'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

class PiRpcClient {
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.extensionDir = options.extensionDir;
    this.piCommand = options.piCommand || 'pi';
    this.envOverrides = options.envOverrides || {};
    this.onEvent = options.onEvent || (() => {});
    this.onExit = options.onExit || (() => {});
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  start() {
    if (this.child) return;
    this.closed = false;
    const bridgePath = path.join(this.extensionDir, 'src', 'pi-eigenscope-bridge.mjs');
    const reviewToolPath = path.join(this.extensionDir, 'src', 'pi-review-tool.mjs');
    const visionGuardPath = path.join(this.extensionDir, 'src', 'pi-vision-guard.mjs');
    const args = ['--mode', 'rpc', '-e', bridgePath, '-e', reviewToolPath, '-e', visionGuardPath];

    this.child = spawn(this.piCommand, args, {
      cwd: this.workspaceRoot,
      env: { ...process.env, ...this.envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.success === false) {
          reject(new Error(msg.error || 'Pi RPC command failed.'));
        } else {
          resolve(msg.data ?? msg);
        }
        return;
      }
      this.onEvent(msg);
    });

    let stderrBuf = '';
    this.child.stderr.on('data', (chunk) => {
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4096);
    });

    const finish = (code, signal, errMessage = '') => {
      if (this.closed) return;
      this.closed = true;
      rl.close();
      const reason = errMessage
        ? `Pi spawn/stream error (${errMessage}).`
        : `Pi exited (${code ?? signal ?? 'terminated'}).`;
      for (const { reject } of this.pending.values()) {
        reject(new Error(reason));
      }
      this.pending.clear();
      this.child = null;
      const combinedStderr = errMessage && !stderrBuf ? errMessage : stderrBuf;
      this.onExit(code, signal, combinedStderr);
    };

    this.child.stdin.on('error', () => {
      // Handled via exit/error listener and sendCommand write try/catch
    });

    this.child.on('error', (err) => {
      finish(-1, null, err ? err.message : 'spawn failed');
    });

    this.child.on('exit', (code, signal) => {
      finish(code, signal);
    });
  }

  sendCommand(type, payload = {}) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error('Pi process is not running.'));
    }
    const id = `vsc-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (err) => {
          if (err && this.pending.has(id)) {
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  prompt(message, images = []) {
    return this.sendCommand('prompt', { message, ...(images.length ? { images } : {}) });
  }

  steer(message) {
    return this.sendCommand('steer', { message });
  }

  abort() {
    return this.sendCommand('abort');
  }

  getAvailableModels() {
    return this.sendCommand('get_available_models');
  }

  setModel(provider, modelId) {
    return this.sendCommand('set_model', { provider, modelId });
  }

  newSession() {
    return this.sendCommand('new_session');
  }

  respondUi(id, response) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...response })}\n`);
    } catch {
      // Ignore write failures when child has closed
    }
  }

  dispose() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // Ignore already-exited child
      }
      this.child = null;
    }
  }
}

module.exports = { PiRpcClient };
