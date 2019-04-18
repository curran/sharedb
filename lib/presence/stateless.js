/*
 * Stateless Presence
 * ------------------
 * 
 * This module provides an implementation of presence that works,
 * but has some scalability problems. Each time a client joins a document,
 * this implementation requests current presence information from all other clients,
 * via the server. The server does not store any state at all regarding presence,
 * it exists only in clients, hence the name "Stateless Presence".
 *
 */
var ShareDBError = require('../error');

// Submit presence data to a document.
// This is the only public facing method. 
// All the others are marked as internal with a leading "_".
function submitPresence(data, callback) {
  if (data != null) {
    if (!this.type) {
      var doc = this;
      return process.nextTick(function() {
        var err = new ShareDBError(4015, 'Cannot submit presence. Document has not been created. ' + doc.collection + '.' + doc.id);
        if (callback) return callback(err);
        doc.emit('error', err);
      });
    }

    if (!this.type.createPresence || !this.type.transformPresence) {
      var doc = this;
      return process.nextTick(function() {
        var err = new ShareDBError(4027, 'Cannot submit presence. Document\'s type does not support presence. ' + doc.collection + '.' + doc.id);
        if (callback) return callback(err);
        doc.emit('error', err);
      });
    }

    data = this.type.createPresence(data);
  }

  if (this._setPresence('', data, true) || this.presence.pending || this.presence.inflight) {
    if (!this.presence.pending) {
      this.presence.pending = [];
    }
    if (callback) {
      this.presence.pending.push(callback);
    }

  } else if (callback) {
    process.nextTick(callback);
  }

  process.nextTick(this.flush.bind(this));
}

// This function generates the initial value for doc.presence.
function _initializePresence() {

  // Return a new object each time, otherwise mutations would bleed across documents.
  return {

    // The current presence data.
    // Map of src -> presence data
    // Local src === ''
    current: {},

    // The presence objects received from the server.
    // Map of src -> presence
    received: {},

    // The minimum amount of time to wait before removing processed presence from this.presence.received.
    // The processed presence is removed to avoid leaking memory, in case peers keep connecting and disconnecting a lot.
    // The processed presence is not removed immediately to enable avoiding race conditions, where messages with lower
    // sequence number arrive after messages with higher sequence numbers.
    receivedTimeout: 60000,

    // If set to true, then the next time the local presence is sent,
    // all other clients will be asked to reply with their own presence data.
    requestReply: true,

    // A list of ops sent by the server. These are needed for transforming presence data,
    // if we get that presence data for an older version of the document.
    cachedOps: [],

    // The ops are cached for at least 1 minute by default, which should be lots, considering that the presence
    // data is supposed to be synced in real-time.
    cachedOpsTimeout: 60000,

    // The sequence number of the inflight presence request.
    inflightSeq: 0,

    // Callbacks (or null) for pending and inflight presence requests.
    pending: null,
    inflight: null
  };
}

function _handlePresence(err, presence) {
  if (!this.subscribed) return;

  var src = presence.src;
  if (!src) {
    // Handle the ACK for the presence data we submitted.
    // this.presence.inflightSeq would not equal presence.seq after a hard rollback,
    // when all callbacks are flushed with an error.
    if (this.presence.inflightSeq === presence.seq) {
      var callbacks = this.presence.inflight;
      this.presence.inflight = null;
      this.presence.inflightSeq = 0;
      var called = callbacks && this._callEach(callbacks, err);
      if (err && !called) this.emit('error', err);
      this.flush();
      this._emitNothingPending();
    }
    return;
  }

  // This shouldn't happen but check just in case.
  if (err) return this.emit('error', err);

  if (presence.r && !this.presence.pending) {
    // Another client requested us to share our current presence data
    this.presence.pending = [];
    this.flush();
  }

  // Ignore older messages which arrived out of order
  if (
    this.presence.received[src] && (
      this.presence.received[src].seq > presence.seq ||
      (this.presence.received[src].seq === presence.seq && presence.v != null)
    )
  ) return;

  this.presence.received[src] = presence;

  if (presence.v == null) {
    // null version should happen only when the server automatically sends
    // null presence for an unsubscribed client
    presence.processedAt = Date.now();
    return this._setPresence(src, null, true);
  }

  // Get missing ops first, if necessary
  if (this.version == null || this.version < presence.v) return this.fetch();

  this._processReceivedPresence(src, true);
}
   
// If emit is true and presence has changed, emits a presence event.
// Returns true, if presence has changed for src. Otherwise false.
function _processReceivedPresence(src, emit) {
  if (!src) return false;
  var presence = this.presence.received[src];
  if (!presence) return false;

  if (presence.processedAt != null) {
    if (Date.now() >= presence.processedAt + this.presence.receivedTimeout) {
      // Remove old received and processed presence.
      delete this.presence.received[src];
    }
    return false;
  }

  if (this.version == null || this.version < presence.v) {
    // keep waiting for the missing snapshot or ops.
    return false;
  }

  if (presence.p == null) {
    // Remove presence data as requested.
    presence.processedAt = Date.now();
    return this._setPresence(src, null, emit);
  }

  if (!this.type || !this.type.createPresence || !this.type.transformPresence) {
    // Remove presence data because the document is not created or its type does not support presence
    presence.processedAt = Date.now();
    return this._setPresence(src, null, emit);
  }

  if (this.inflightOp && this.inflightOp.op == null) {
    // Remove presence data because presence.received can be transformed only against "op", not "create" nor "del"
    presence.processedAt = Date.now();
    return this._setPresence(src, null, emit);
  }

  for (var i = 0; i < this.pendingOps.length; i++) {
    if (this.pendingOps[i].op == null) {
      // Remove presence data because presence.received can be transformed only against "op", not "create" nor "del"
      presence.processedAt = Date.now();
      return this._setPresence(src, null, emit);
    }
  }

  var startIndex = this.presence.cachedOps.length - (this.version - presence.v);
  if (startIndex < 0) {
    // Remove presence data because we can't transform presence.received
    presence.processedAt = Date.now();
    return this._setPresence(src, null, emit);
  }

  for (var i = startIndex; i < this.presence.cachedOps.length; i++) {
    if (this.presence.cachedOps[i].op == null) {
      // Remove presence data because presence.received can be transformed only against "op", not "create" nor "del"
      presence.processedAt = Date.now();
      return this._setPresence(src, null, emit);
    }
  }

  // Make sure the format of the data is correct
  var data = this.type.createPresence(presence.p);

  // Transform against past ops
  for (var i = startIndex; i < this.presence.cachedOps.length; i++) {
    var op = this.presence.cachedOps[i];
    data = this.type.transformPresence(data, op.op, presence.src === op.src);
  }

  // Transform against pending ops
  if (this.inflightOp) {
    data = this.type.transformPresence(data, this.inflightOp.op, false);
  }

  for (var i = 0; i < this.pendingOps.length; i++) {
    data = this.type.transformPresence(data, this.pendingOps[i].op, false);
  }

  // Set presence data
  presence.processedAt = Date.now();
  return this._setPresence(src, data, emit);
}

function _processAllReceivedPresence() {
  if (!this.presence) return;
  var srcList = Object.keys(this.presence.received);
  var changedSrcList = [];
  for (var i = 0; i < srcList.length; i++) {
    var src = srcList[i];
    if (this._processReceivedPresence(src)) {
      changedSrcList.push(src);
    }
  }
  this._emitPresence(changedSrcList, true);
}

function _transformPresence(src, op) {
  var presenceData = this.presence.current[src];
  if (op.op != null) {
    var isOwnOperation = src === (op.src || '');
    presenceData = this.type.transformPresence(presenceData, op.op, isOwnOperation);
  } else {
    presenceData = null;
  }
  return this._setPresence(src, presenceData);
}
 
function _transformAllPresence(op) {
  if (!this.presence) return;
  var srcList = Object.keys(this.presence.current);
  var changedSrcList = [];
  for (var i = 0; i < srcList.length; i++) {
    var src = srcList[i];
    if (this._transformPresence(src, op)) {
      changedSrcList.push(src);
    }
  }
  this._emitPresence(changedSrcList, false);
}

function pause() {
  if (!this.presence) return;

  if (this.presence.inflight) {
    this.presence.pending = this.presence.pending
      ? this.presence.inflight.concat(this.presence.pending)
      : this.presence.inflight;
    this.presence.inflight = null;
    this.presence.inflightSeq = 0;
  } else if (!this.presence.pending && this.presence.current[''] != null) {
    this.presence.pending = [];
  }
  this.presence.received = {};
  this.presence.requestReply = true;
  var srcList = Object.keys(this.presence.current);
  var changedSrcList = [];
  for (var i = 0; i < srcList.length; i++) {
    var src = srcList[i];
    if (src && this._setPresence(src, null)) {
      changedSrcList.push(src);
    }
  }
  this._emitPresence(changedSrcList, false);
}

// If emit is true and presence has changed, emits a presence event.
// Returns true, if presence has changed. Otherwise false.
function _setPresence(src, data, emit) {
  if (data == null) {
    if (this.presence.current[src] == null) return false;
    delete this.presence.current[src];
  } else {
    var isPresenceEqual =
      this.presence.current[src] === data ||
      (this.type.comparePresence && this.type.comparePresence(this.presence.current[src], data));
    if (isPresenceEqual) return false;
    this.presence.current[src] = data;
  }
  if (emit) this._emitPresence([ src ], true);
  return true;
}

function _emitPresence(srcList, submitted) {
  if (srcList && srcList.length > 0) {
    var doc = this;
    process.nextTick(function() {
      doc.emit('presence', srcList, submitted);
    });
  }
}

function _cacheOp(op) {
  if (!this.presence) return;
  // Remove the old ops.
  var oldOpTime = Date.now() - this.presence.cachedOpsTimeout;
  var i;
  for (i = 0; i < this.presence.cachedOps.length; i++) {
    if (this.presence.cachedOps[i].time >= oldOpTime) {
      break;
    }
  }
  if (i > 0) {
    this.presence.cachedOps.splice(0, i);
  }

  // Cache the new op.
  this.presence.cachedOps.push(op);
}

// If there are no pending ops, this method sends the pending presence data, if possible.
function flush() {
  if (this.subscribed && !this.presence.inflight && this.presence.pending && !this.hasWritePending()) {
    this.presence.inflight = this.presence.pending;
    this.presence.inflightSeq = this.connection.seq;
    this.presence.pending = null;
    this.connection.sendPresence(this, this.presence.current[''], this.presence.requestReply);
    this.presence.requestReply = false;
  }
}

function destroy() {
  this.presence.received = {};
  this.presence.cachedOps.length = 0;
}

// Reset presence-related properties.
function _hardRollbackPresence() {
  var pendingPresence = [];
  if (this.presence.inflight) pendingPresence.push(this.presence.inflight);
  if (this.presence.pending) pendingPresence.push(this.presence.pending);

  this.presence.inflight = null;
  this.presence.inflightSeq = 0;
  this.presence.pending = null;
  this.presence.cachedOps.length = 0;
  this.presence.received = {};
  this.presence.requestReply = true;

  var srcList = Object.keys(this.presence.current);
  var changedSrcList = [];
  for (var i = 0; i < srcList.length; i++) {
    var src = srcList[i];
    if (this._setPresence(src, null)) {
      changedSrcList.push(src);
    }
  }
  this._emitPresence(changedSrcList, false);
  return pendingPresence;
}

var Presence = {
  submitPresence,
  _initializePresence,
  _handlePresence,
  _processReceivedPresence,
  _processAllReceivedPresence,
  _transformPresence,
  _transformAllPresence,
  pause,
  _setPresence,
  _emitPresence,
  _cacheOp,
  flush,
  destroy,
  _hardRollbackPresence
};

module.exports = Presence;
