module.exports = HashWithLength;

function HashWithLength() {
	this._store = {};
	this._length = 0;
}

var p = HashWithLength.prototype;

p.set = function(key, value) {
	if (! (key in this._store) ) this._length++;
	this._store[key] = value;
};

p.get = function(key) {
	return this._store[key];
};

p.has = function(key) {
	return (key in this._store);
};

p.del = function(key) {
	if ( (key in this._store) ) {
		this._length--;
		delete this._store[key];
	}
};

p.length = function() {
	return this._length;
};

p.for_each = function(visitor_callback) {
	for (var key in this._store) {
		if ( visitor_callback(this._store[key], key) === false )
			return; // when the visitor_callback returns false, we break the iteration
	}
};
