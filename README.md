IPCluster
=========

IPCluster is a "bare-metal" library for Node.js to manage multi-core concurrency, with sticky sessions and zero-downtime reloading.

Features
--------
* Sticky sessions (via iptables abuse) - suitable for long-polling
* Configurable per-process and cluster memory limits
* Graceful shutdowns and restarts
* Renice older workers

Dependencies
------------
* npm modules - commander, q

_IPCluster sticky sessions currently requires `iptables` for sticky sessions and so is Linux-only_

Setup
=====

npm dependencies
----------------
    npm install

iptables sudo support
---------------------
sudo iptables support is required in order to support sticky sessions.

Add to sudoers (visudo):

    <node> ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -L
    <node> ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -[ID] PREROUTING -p tcp -m tcp -s 0.0.0.*/0.0.0.* -d * --dport 80 -j REDIRECT --to-ports ?????
    <node> ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -[ID] PREROUTING -p tcp -m tcp -s 0.0.0.*/0.0.0.* -d * --dport 443 -j REDIRECT --to-ports ?????
etc. for other ports

Change `<node>` to the running user.

Thankfully, iptables does not allow duplicate copies of most flags, so that the `*` wildcards can't be abused (much). Nonetheless, sercurity feedback is welcome. An alternative for `*` would be appreciated.

Usage
=====
    npm install ipcluster --save

See https://github.com/zopim/ipcluster-example for a simple example.

In your application
-------------------

### Deploying new code / Running a new batch of workers

Once you app is ipcluster-enabled, starting it should start a master that will spawn multiple workers. The workers are _not_ child processes (they will outlive the master).

To start a new batch a workers (e.g. when you are deployig new code), you should kill off the old master, and start a new master. The old workers will still be running happily.

Restarting a new master will do 2 things:
  - Spawn a new generation of workers, running your latest code for all new incoming connections
  - Become the master for all old workers, and manage their retirement and (eventual) destruction

Note: you can restart a new master without first killing the old one. The new master will find and terminate the old master as part of its boot up sequence.

Signals
-------
The master process understands these signals:
  - `SIGUSR1`: Kills all retired workers.

Contributing
============

git pre-commit hook
-------------------
Being a JS project, we require the code to be lint free, based on our Zopim's jshint rules (see the file .jshtinrc at the root of the project for details)

### Installing jshint

Make sure you add "/usr/local/share/npm/bin" to your PATH, and then do the install as follow:

    # installing jshint
    npm install jshint -g

    # testing install, should show "jshint vX.Y.Z"
    jshint -version

### Running jshint

Run jshint on the whole source tree

    jshint lib

Testing
-------
ipcluster contains some unit tests made with [nodeunit](https://github.com/caolan/nodeunit) (with many more to come, thanks to **you**!). The tests can be run with [grunt](http://gruntjs.com/), the task runner. At the root of the project run:

    grunt test

Do run the test suite (which also run jshint), prior to committing.

Installing grunt
----------------
    npm install -g grunt-cli

Copyright and license
=====================
Copyright 2014 Zopim

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.

You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
