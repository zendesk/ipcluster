var os = require('os'),
	path = require('path'),
	util = require('util'),
	clog = require('./clogger')('[IPCluster]');

var isWorker = (('__ZWORKER__' in process.env) && process.env.__ZWORKER__ === 'TRUE');
var master = null;
var worker = null;

function noop(){}

var cluster = module.exports = {
	isWorker:    isWorker,
	isMaster:    !isWorker,
	master:      master,
	worker:      worker,
	setupWorker: noop,
	setupMaster: noop
};

if (isWorker) {
	cluster.setupWorker = function(settings) {
		var Worker = require('./worker'); // import here to work around circular dependencies
		settings = tune_settings(settings);
		this.worker = new Worker(
			settings,
			('__ZWORKER__BAND__' in process.env
				? parseInt(process.env.__ZWORKER__BAND__, 10)
				: -1
			)
		);
	};
}
else {
	cluster.setupMaster = function(settings) {
		var Master = require('./master'); // import here to work around circular dependencies
		settings = tune_settings(settings);
		clog(settings);
		this.master = new Master(settings);
	};
}

function tune_settings(settings) {
	settings = util._extend({}, settings);

	if (! ('uds' in settings) ) {
		if (!('hostname' in settings) || !settings.hostname) {
			throw new Error('invalid settings provided');
		}

		var tmpdir = (os.tmpdir && os.tmpdir()) || os.tmpDir();

		settings.uds = path.join(tmpdir, settings.hostname + '.zsocket');
	}

	return settings;
}
