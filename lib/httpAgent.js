/**
 * @license
 * Copyright 2015 Telefónica Investigación y Desarrollo, S.A.U
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This module is a modification from nodeJs default HTTP agent:
// https://github.com/joyent/node/blob/f3189ace6b5e31a874df421ac2f74da0e77cb14d/lib/_http_agent.js
//
//
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var net = require('net'),
    tls = require('tls'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter;

function initRequestOptions(agent, req, options) {
  options = util._extend({}, options);
  options = util._extend(options, agent.agentOptions);

  options.servername = options.host;
  if (req) {
    var hostHeader = req.getHeader('host');
    if (hostHeader) {
      options.servername = hostHeader.replace(/:.*$/, '');
    }
  }

  return options;
}

/**
 * New Agent code. The largest departure from the previous implementation is that
 * an Agent instance holds connections for a variable number of host:ports.
 * Surprisingly, this is still API compatible as far as third parties are
 * concerned. The only code that really notices the difference is the
 * request object. Another departure is that all code related to HTTP parsing is in
 * ClientRequest.onSocket(). The Agent is now *strictly*
 * concerned with managing a connection pool.
 *
 * @param {Object=} agentOptions keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets
 * @constructor
 */
function Agent(agentOptions) {

  if (!(this instanceof Agent)) {
    return new Agent(agentOptions);
  }

  EventEmitter.call(this);

  var self = this;

  self.defaultPort = 80;
  self.protocol = 'http:';

  self.agentOptions = util._extend({}, agentOptions);

  // don't confuse net and make it think that we're connecting to a pipe
  self.agentOptions.path = null;
  self.requests = {};
  self.sockets = {};
  self.freeSockets = {};
  self.keepAliveMsecs = self.agentOptions.keepAliveMsecs || 30000;
  self.keepAlive = self.agentOptions.keepAlive || true;
  self.maxSockets = self.agentOptions.maxSockets || Agent.defaultMaxSockets;
  self.maxFreeSockets = self.agentOptions.maxFreeSockets || Infinity;
  self.freeSocketsTimeout = self.agentOptions.freeSocketsTimeout || 45000;

  self.on('free', function(socket, options) {
    var name = self.getName(options);
    var destroyed = socket._destroyed || socket.destroyed;

    if (!destroyed &&
        self.requests[name] && self.requests[name].length) {
      self.requests[name].shift().onSocket(socket);
      if (self.requests[name].length === 0) {
        // don't leak
        delete self.requests[name];
      }
    } else {
      // If there are no pending requests, then put it in
      // the freeSockets pool, but only if we're allowed to do so.
      var req = socket._httpMessage;
      if (req &&
          req.shouldKeepAlive && !destroyed &&
          self.agentOptions.keepAlive) {
        var freeSockets = self.freeSockets[name];
        var freeLen = freeSockets ? freeSockets.length : 0;
        var count = freeLen;
        if (self.sockets[name]) {
          count += self.sockets[name].length;
        }

        if (count >= self.maxSockets + 1 || freeLen >= self.maxFreeSockets) {
          self.removeSocket(socket, options);
          socket.destroy();
        } else {
          freeSockets = freeSockets || [];
          self.freeSockets[name] = freeSockets;
          socket.setKeepAlive(true, self.keepAliveMsecs);

          // The unref in an SSL Sockets must be done in the real TCP socket.
          var tcpSocket = (socket.socket) ? socket.socket : socket;
          tcpSocket.unref();

          socket._httpMessage = null;
          freeSockets.push(socket);
          // Sockets in the freeSockets pool are closed when
          // they are idle.
          socket.freeTimeoutCb = function() {
            socket.destroy();
            // Immediately remove the socket from the freeSockets pool
            // instead of waiting the close event.
            self.removeSocket(socket, options);
          };
          socket.setTimeout(self.freeSocketsTimeout, socket.freeTimeoutCb);
          self.removeSocket(socket, options);
        }
      } else {
        self.removeSocket(socket, options);
        socket.destroy();
      }
    }
  });
}

util.inherits(Agent, EventEmitter);

/**
 * The Agent Class
 * @type {Agent}
 */
exports.Agent = Agent;

/**
 * The default maxSockets per agent
 * @type {Number}
 */
Agent.defaultMaxSockets = Infinity;

/**
 * Create Connection
 * @type {Function}
 */
Agent.prototype.createConnection = net.createConnection;

/**
 * Get the key for a given set of request options
 * @param {Object} options
 * @return {string}
 */
Agent.prototype.getName = function(options) {
  var name = '';
  if (options.host) {
    name += options.host;
  } else {
    name += 'localhost';
  }

  name += ':';
  if (options.port) {
    name += options.port;
  }

  name += ':';
  if (options.localAddress) {
    name += options.localAddress;
  }

  name += ':';
  return name;
};

/**
 * Add Request to agent
 * @param {OutgoingMessage} req
 * @param {Object} options
 */
Agent.prototype.addRequest = function(req, options) {
  // Legacy API: addRequest(req, host, port, localAddress)
  if (typeof options === 'string') {
    options = {
      host: options,
      port: arguments[2],
      localAddress: arguments[3]
    };
  }
  // Initialize the request options here instead of createSocket to make sure that
  // the calls to getName it is always performed using the same object, and so the
  // connections of the pool are properly reused and released
  options = initRequestOptions(this, req, options);

  var name = this.getName(options);
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }

  var freeLen = this.freeSockets[name] ? this.freeSockets[name].length : 0;

  var sockLen = freeLen + this.sockets[name].length;
  if (freeLen) {
    // We have a free socket, so use that. Uses the last released socket
    // to let old socket close for inactivity.
    var socket = this.freeSockets[name].pop();

    // Clear the inactivity timeout
    if (socket.freeTimeoutCb) {
      socket.setTimeout(0, socket.freeTimeoutCb);
      socket.freeTimeoutCb = null;
    }

    // don't leak
    if (!this.freeSockets[name].length) {
      delete this.freeSockets[name];
    }

    // The ref in an SSL Sockets must be done in the real TCP socket.
    var tcpSocket = (socket.socket) ? socket.socket : socket;
    tcpSocket.ref();

    // Add the reused socket to the request domain if present
    if (req.domain) {
      req.domain.add(socket);
    }
    req.onSocket(socket);
    this.sockets[name].push(socket);
  } else if (sockLen < this.maxSockets) {
    // If we are under maxSockets create a new one.
    req.onSocket(this.createSocket(req, options));
  } else {
    // We are over limit so we'll add it to the queue.
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(req);
  }
};

/**
 * Create a socket to manage the request
 * @param {ClientRequest} req
 * @param {Object} options
 * @return {Socket}
 */
Agent.prototype.createSocket = function(req, options) {
  var self = this;
  var name = self.getName(options);

  options.encoding = null;
  var s = self.createConnection(options);
  if (!self.sockets[name]) {
    self.sockets[name] = [];
  }
  this.sockets[name].push(s);

  function onFree() {
    self.emit('free', s, options);
  }

  s.on('free', onFree);

  function onClose() {
    // This is the only place where sockets get removed from the Agent.
    // If you want to remove a socket from the pool, just close it.
    // All socket errors end in a close event anyway.
    self.removeSocket(s, options);
  }

  s.on('close', onClose);

  function onRemove() {
    // We need this function for cases like HTTP 'upgrade'
    // (defined by WebSockets) where we need to remove a socket from the
    // pool because it'll be locked up indefinitely
    self.removeSocket(s, options);
    s.removeListener('close', onClose);
    s.removeListener('free', onFree);
    s.removeListener('agentRemove', onRemove);
  }
  s.on('agentRemove', onRemove);
  return s;
};

/**
 * Remove a Socket from the Agent
 * @param {Socket} s
 * @param {Object} options
 */
Agent.prototype.removeSocket = function(s, options) {
  var name = this.getName(options);
  var destroyed = s._destroyed || s.destroyed;
  var sets = [this.sockets];

  // If the socket was destroyed, remove it from the free buffers too.
  if (destroyed) {
    sets.push(this.freeSockets);
  }

  sets.forEach(function(sockets) {
    if (sockets[name]) {
      var index = sockets[name].indexOf(s);
      if (index !== -1) {
        sockets[name].splice(index, 1);
        // Don't leak
        if (sockets[name].length === 0) {
          delete sockets[name];
        }
      }
    }
  });
  if (this.requests[name] && this.requests[name].length) {
    var req = this.requests[name][0];
    // If we have pending requests and a socket gets closed make a new one
    this.createSocket(req, options).emit('free');
  }
};

/**
 * Destroy the agent, liberating all sockets
 * and making cleanup
 */
Agent.prototype.destroy = function() {
  var sets = [this.freeSockets, this.sockets];
  sets.forEach(function(set) {
    Object.keys(set).forEach(function(name) {
      set[name].forEach(function(socket) {
        socket.destroy();
      });
    });
  });
};

function createConnectionSSL(port, host, options) {
  // isObject
  if (port === Object(port)) {
    options = port;
  } else if (host === Object(host)) {
    options = host;
  } else if (options === Object(options)) {
    options = options;
  } else {
    options = {};
  }

  if (typeof port === 'number') {
    options.port = port;
  }

  if (typeof host === 'string') {
    options.host = host;
  }

  return tls.connect(options);
}

/**
 * The SSL Agent
 * @param {Object=} agentOptions
 * @constructor
 */
function SSLAgent(agentOptions) {
  Agent.call(this, agentOptions);
  this.defaultPort = 443;
  this.protocol = 'https:';
}
util.inherits(SSLAgent, Agent);

/**
 * Create SSL Connection
 * @type {Function}
 */
SSLAgent.prototype.createConnection = createConnectionSSL;

/**
 * Get the name for the SSL socket
 * @param {Object} options
 * @return {String}
 */
SSLAgent.prototype.getName = function(options) {
  var name = Agent.prototype.getName.call(this, options);

  name += ':';
  if (options.ca) {
    name += options.ca;
  }

  name += ':';
  if (options.cert) {
    name += options.cert;
  }

  name += ':';
  if (options.ciphers) {
    name += options.ciphers;
  }

  name += ':';
  if (options.key) {
    name += options.key;
  }

  name += ':';
  if (options.pfx) {
    name += options.pfx;
  }

  name += ':';

  if (options.rejectUnauthorized !== undefined) {
    name += options.rejectUnauthorized;
  }

  return name;
};

/**
 * Holder for the SSL Agent
 * @type {{}}
 */
exports.SSL = {};

/**
 * The SSL Agent Class
 * @type {Function}
 */
exports.SSL.Agent = SSLAgent;
