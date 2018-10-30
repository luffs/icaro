(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.ikarhu = factory());
}(this, (function () { 'use strict';

// fork of https://github.com/YuzuJS/setImmediate
((function (global) {
  if (global.setImmediate) {
    return
  }

  const tasksByHandle = {};

  let nextHandle = 1; // Spec says greater than zero
  let currentlyRunningATask = false;
  let registerImmediate;

  function setImmediate(callback) {
    tasksByHandle[nextHandle] = callback;
    registerImmediate(nextHandle);
    return nextHandle++
  }

  function clearImmediate(handle) {
    delete tasksByHandle[handle];
  }

  function runIfPresent(handle) {
    // From the spec: "Wait until any invocations of this algorithm started before this one have completed."
    // So if we're currently running a task, we'll need to delay this invocation.
    if (currentlyRunningATask) {
      // Delay by doing a setTimeout. setImmediate was tried instead, but in Firefox 7 it generated a
      // "too much recursion" error.
      setTimeout(runIfPresent, 0, handle);
    } else {
      const task = tasksByHandle[handle];
      if (task) {
        currentlyRunningATask = true;
        try {
          task();
        } finally {
          clearImmediate(handle);
          currentlyRunningATask = false;
        }
      }
    }
  }

  function installNextTickImplementation() {
    registerImmediate = handle => {
      process.nextTick(() => { runIfPresent(handle); });
    };
  }

  function installPostMessageImplementation() {
    // Installs an event handler on `global` for the `message` event: see
    // * https://developer.mozilla.org/en/DOM/window.postMessage
    // * http://www.whatwg.org/specs/web-apps/current-work/multipage/comms.html#crossDocumentMessages
    const messagePrefix = `setImmediate$${Math.random()}$`;
    const onGlobalMessage = event => {
      if (event.source === global &&
                typeof event.data === 'string' &&
                event.data.indexOf(messagePrefix) === 0) {
        runIfPresent(+event.data.slice(messagePrefix.length));
      }
    };

    global.addEventListener('message', onGlobalMessage, false);

    registerImmediate = handle => {
      global.postMessage(messagePrefix + handle, '*');
    };
  }

  // Don't get fooled by e.g. browserify environments.
  if ({}.toString.call(global.process) === '[object process]') {
    // For Node.js before 0.9
    installNextTickImplementation();
  } else {
    // For non-IE10 modern browsers
    installPostMessageImplementation();
  }

  global.setImmediate = setImmediate;
  global.clearImmediate = clearImmediate;

}))(typeof self === 'undefined' ? typeof global === 'undefined' ? window : global : self);

const listeners = new WeakMap();
const snitches = new WeakMap();
const dispatch = Symbol();
const isIcaro = Symbol();
const timer = Symbol();
const isArray = Symbol();
const changes = Symbol();
const rollback = Symbol();
const DELETED = '__deleted__';

/**
 * Public api
 * @type {Object}
 */
const API = {
  /**
   * Set a listener on any object function or array
   * @param   {Function} fn - callback function associated to the property to listen
   * @returns {API}
   */
  listen(fn) {
    const type = typeof fn;
    if(type !== 'function')
      throw `The icaro.listen method accepts as argument "typeof 'function'", "${type}" is not allowed`

    if (!listeners.has(this)) listeners.set(this, []);
    listeners.get(this).push(fn);

    return this
  },

  /**
   * Unsubscribe to a property previously listened or to all of them
   * @param   {Function} fn - function to unsubscribe
   * @returns {API}
   */
  unlisten(fn) {
    const callbacks = listeners.get(this);
    if (!callbacks) return
    if (fn) {
      const index = callbacks.indexOf(fn);
      if (~index) callbacks.splice(index, 1);
    } else {
      listeners.set(this, []);
    }

    return this
  },

  /**
   * Convert the ikarhu object into a valid JSON object
   * @returns {Object} - simple json object from a Proxy
   */
  toJSON() {
    return Object.keys(this).reduce((ret, key) => {
      const value = this[key];
      ret[key] = value && value.toJSON ? value.toJSON() : value;
      return ret
    }, this[isArray] ? [] : {})
  },
  patch(changes) {
    // failedChanges can be used to rollback to the valid values
    let failedChanges = JSON.parse(JSON.stringify(changes));
    let errors = [];
    let oldValues = {};
    patchObject(this, changes, failedChanges, oldValues);
    if (Object.keys(failedChanges).length !== 0) {
        throw {errors: errors, rollback: failedChanges, toString: () => JSON.stringify(errors)};
    }

    function patchObject(target, changes, failedChanges, oldValues) {
      Object.keys(changes).forEach(key => {
        // call patchObject recursively if object
        if (isObject(changes[key]) && isObject(target[key])) {
          oldValues[key] = {};
          patchObject(target[key], changes[key], failedChanges[key], oldValues[key]);
          if (Object.keys(changes[key]).length === 0) {
            // no change occurred
            delete changes[key];
          }
          if (Object.keys(failedChanges[key]).length === 0) {
            // all changes succeeded
            delete failedChanges[key];
          }
          if (Object.keys(oldValues[key]).length === 0) {
            // no old values
            delete oldValues[key];
          }
        }
        else {
          // update the values. might throw if target is a proxy
          try {
            if (target[key] !== undefined) {
              oldValues[key] = target[key];
            }

            // if the property is to be deleted
            if (changes[key] === DELETED) {
              if (Array.isArray(target)) {
                target.splice(Number(key), 1);
              }
              else {
                delete target[key];
              }
              delete failedChanges[key];
            }
            // value is the same, do nothing
            else if (target[key] === changes[key]) {
              delete changes[key];
              delete failedChanges[key];
            }
            else {
              // update the value
              target[key] = changes[key];
              delete failedChanges[key];
            }
          } catch (e) {
            // invalid update
            delete changes[key];
            delete oldValues[key];

            // if the update failed, return the previous value to the user
            failedChanges[key] = target && target.hasOwnProperty(key) ? target[key] : DELETED;

            // also return the reason why
            errors.push(e.toString());
          }
        }
      });
      if (listeners.has(target) && Object.keys(changes).length > 0) {
        listeners.get(target).forEach(function (fn) {
          fn(changes, oldValues);
        });
      }
    }
  },
};

/**
 * Icaro proxy handler
 * @type {Object}
 */
const IKARHU_HANDLER = {
  set(target, property, value) {
    // filter the values that didn't change
    if (target[property] !== value) {
      //console.log('set', target, property, value);
      let oldValue = target[property];
      target[property] = value;
      //filter symbolic properties that are used internally in ikarhu
      if ( typeof property !== 'symbol' ) {
        target[dispatch](property, value, oldValue);
      }
    }
    return true
  },
  get(target, property) {
    //console.log('get ikarhu', target, property);
    let targetProp = target[property];
    if ( isObject(targetProp) && !targetProp[isIcaro] ) {
      if ( !snitches.has(targetProp) ) {
        snitches.set( targetProp, makeSnitch(target, property, [], target, property) );
      }
      return snitches.get( targetProp );
    }
    else {
      return targetProp;
    }
  },
  deleteProperty(target, property) {
    //console.log('delete', target, property);
    delete target[property];
    target[dispatch](property, DELETED);
    return true;
  }
};

/**
 * Define a private property
 * @param   {*} obj - receiver
 * @param   {String} key - property name
 * @param   {*} value - value to set
 */
function define(obj, key, value) {
  Object.defineProperty(obj, key, {
    value:  value,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

/**
 * Enhance the ikarhu objects adding some hidden props to them and the API methods
 * @param   {*} obj - anything
 * @returns {*} the object received enhanced with some extra properties
 */
function enhance(obj) {
  // add some "kinda hidden" properties
  Object.assign(obj, {
    [changes]: {},
    [rollback]: {},
    [timer]: null,
    [isIcaro]: true,
    [dispatch](property, value, oldValue) {
      //console.log('dispatch', 'prop', property, 'value', value, 'stack', stack);
      if (listeners.has(obj)) {
        clearImmediate(obj[timer]);
        mergeDeep(obj[changes], {[property]: value});
        if ( oldValue !== undefined ) {
          mergeDeep(obj[rollback], {[property]: oldValue});
        }
        obj[timer] = setImmediate(function () {
          listeners.get(obj).forEach(function (fn) {
            fn(obj[changes], obj[rollback]);
          });
          obj[changes] = {};
          obj[rollback] = {};
        });
      }
    }
  });

  // Add the API methods bound to the original object
  Object.keys(API).forEach(function (key) {
    define(obj, key, API[key].bind(obj));
  });

  // used by toJSON
  if (Array.isArray(obj)) {
    obj[isArray] = true;
  }

  return obj
}

/**
 * Snitches notifies the orgTarget when there is a change to any element below it
 * @param   {*} target - anything
 * @param   {*} property - anything
 * @param   {*} parents - anything
 * @param   {*} orgTarget - anything
 * @param   {*} orgProp - anything
 * @returns {*} a proxy for the target property
 */
function makeSnitch(target, property, parents, orgTarget, orgProp){
  return new Proxy(target[property], {
    get(child, prop, receiver){
      if ( isObject(child[prop]) ) {
        if ( !snitches.has(child[prop]) ) {
          snitches.set( child[prop], makeSnitch(child, prop, [prop].concat(parents), orgTarget, orgProp) );
        }
        return snitches.get( child[prop] );
      }
      else if ( typeof child[prop] === 'function' ) {
        //return a function that calls the original function with the correct context
        return (...args) => child[prop].apply(receiver, args);
      }
      return child[prop];
    },
    set(child, prop, value){
      //no need to dispatch when nothing has changed
      if ( child[prop] !== value ) {
        let changes = {[prop] : value};
        parents.forEach(function(parent){
          changes = {[parent]: changes};
        });

        child[prop] = value;
        orgTarget[dispatch](orgProp, changes);
      }
      return true;
    },
    deleteProperty(child, prop){
      let changes = {[prop] : DELETED};
      parents.forEach(function(parent){
        changes = {[parent]: changes};
      });
      delete child[prop];

      orgTarget[dispatch](orgProp, changes);
      return true;
    }
  });
}

function mergeDeep(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, {[key]: {}});
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, {[key]: source[key]});
      }
    }
  }

  return mergeDeep(target, ...sources);
}

function isObject(val) {
  return val && typeof val === 'object';
}

/**
 * Factory function
 * @param   {*} obj - anything can be an ikarhu Proxy
 * @returns {Proxy}
 */
function ikarhu(obj) {
  return new Proxy(
    enhance(obj || {}),
    Object.create(IKARHU_HANDLER)
  )
}

return ikarhu;

})));
