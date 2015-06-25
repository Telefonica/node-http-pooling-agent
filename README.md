# http-pooling-agent

HTTP agent with smart socket pool.

[![npm version](https://badge.fury.io/js/http-pooling-agent.svg)](http://badge.fury.io/js/http-pooling-agent)
[![Build Status](https://travis-ci.org/telefonica/node-http-pooling-agent.svg)](https://travis-ci.org/telefonica/node-http-pooling-agent)

The HTTP agent is based on original [node HTTP agent](https://github.com/joyent/node/blob/f3189ace6b5e31a874df421ac2f74da0e77cb14d/lib/_http_agent.js) with some modifications in order to:
* Do not close sockets if there is no pending HTTP request. Default HTTP agent only reuses an open socket if there is a request already waiting for delivery. However, in stress situations, it is probable to close a socket that could be reused for a new request that is about to reach, degrading the performance and exhausting the available sockets to open new connections.
* Close sockets after a configurable period of inactivity to save resources. It uses the `freeSocketsTimeout` option to set up this inactivity period (in milliseconds).

Unlike other available HTTP agents, sockets are not opened forever. After an inactivity period, they are closed to save resources.

## Installation

```bash
npm install http-pooling-agent
```

## Basic usage

### HTTP usage

```js
var http = require('http'),
    httpAgent = require('http-pooling-agent');

var agent = new httpAgent.Agent({
  freeSocketsTimeout: 10000
});

var options = {
  host: 'localhost',
  port: 3000,
  path: '/',
  method: 'GET',
  agent: agent
};
var req = http.request(options, function (res) {
});
req.end();
```

### HTTPS usage

```js
var https = require('https'),
    httpAgent = require('http-pooling-agent');

var agent = new httpAgent.SSL.Agent({
  keepAliveMsecs: 5000
});

var options = {
  host: 'localhost',
  port: 8443,
  path: '/',
  method: 'GET',
  agent: agent
};
var req = https.request(options, function (res) {
});
req.end();
```

## Configuration

The agent is configured with a set of options:

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| keepAlive | Boolean | true | Keep sockets around in a pool to be used by other requests in the future |
| keepAliveMsecs | Integer | 30000 | When using HTTP KeepAlive, how often to send TCP KeepAlive packets over sockets being kept alive. Only relevant if keepAlive is set to true. |
| maxSockets | Number | Infinity | Maximum number of sockets to allow per host. |
| maxFreeSockets | Number | Infinity | Maximum number of sockets to leave open in a free state. Only relevant if keepAlive is set to true. |
| freeSocketsTimeout | Integer | 45000 | Maximum inactivity period (in milliseconds) to keep open an idle socket. |

**NOTE**: These options are the same options than the [default agent](https://nodejs.org/api/http.html#http_new_agent_options) with two differences:
* Default values are different.
* The option `freeSocketsTimeout` does not exist in the default agent.

## License

Copyright 2015 [Telefónica Investigación y Desarrollo, S.A.U](http://www.tid.es)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
