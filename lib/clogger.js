module.exports = function(prefix) {
	return function() {
		var args = [].slice.call(arguments);

		args.unshift(prefix);

		console.log.apply(console, args);
	};
};
