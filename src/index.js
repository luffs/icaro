const listeners = new WeakMap(),
  snitches = new WeakMap(),
  dispatch = Symbol(),
  isIkarhu = Symbol(),
  timer = Symbol(),
  isArray = Symbol(),
  changes = Symbol(),
  DELETED = '__deleted__',
  NULL = '__null__';

import './set-immediate'

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
    const type = typeof fn
    if(type !== 'function')
      throw `The icaro.listen method accepts as argument "typeof 'function'", "${type}" is not allowed`

    if (!listeners.has(this)) listeners.set(this, [])
    listeners.get(this).push(fn)

    return this
  },

  /**
   * Unsubscribe to a property previously listened or to all of them
   * @param   {Function} fn - function to unsubscribe
   * @returns {API}
   */
  unlisten(fn) {
    const callbacks = listeners.get(this)
    if (!callbacks) return
    if (fn) {
      const index = callbacks.indexOf(fn)
      if (~index) callbacks.splice(index, 1)
    } else {
      listeners.set(this, [])
    }

    return this
  },

  /**
   * Convert the ikarhu object into a valid JSON object
   * @returns {Object} - simple json object from a Proxy
   */
  toJSON() {
    return Object.keys(this).reduce((ret, key) => {
      const value = this[key]
      ret[key] = value && value.toJSON ? value.toJSON() : value
      return ret
    }, this[isArray] ? [] : {})
  },
  diff(changes) {
    patch(this, changes, true);
    changes = convertArrayToObject( changes );

    if (listeners.has(this) && Object.keys(changes).length > 0) {
      listeners.get(this).forEach( fn => fn(changes) );
    }
  },
  patch(changes) {

    patch(this, changes);

    if (listeners.has(this) && Object.keys(changes).length > 0) {
      listeners.get(this).forEach( fn => fn(changes) );
    }
  },
}

/**
 * Icaro proxy handler
 * @type {Object}
 */
const IKARHU_HANDLER = {
  set(target, property, value) {
		// filter the values that didn't change
    if (target[property] !== value) {
			//console.log('set', target, property, value);
      target[property] = value;
			//filter symbolic properties that are used internally in ikarhu
      if ( typeof property !== 'symbol' ) {
        target[dispatch](property, value);
      }
    }
    return true
  },
  get(target, property) {
		//console.log('get ikarhu', target, property);
    let targetProp = target[property];
    if ( isObject(targetProp) && !targetProp[isIkarhu] ) {
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

function patch(target, changes, deleteMissing){
  if ( deleteMissing ) {
    Object.keys(target).forEach( key => {
      if ( changes[key] === undefined ) {
        changes[key] = DELETED;
      }
    });
    Object.keys(changes).forEach( key => {
      changes[key] = changes[key] === null && target[key] !== null ? NULL : changes[key];
    })
  }

  Object.keys( changes )
		.sort( ( a,b ) => isNaN(a) || isNaN(b) ? (a < b ? -1 : 1) : a - b )
		.reverse()
		.forEach( key => {
			// both arrays or objects, really
  let bothAreObjects = isObject(target[key]) && isObject(changes[key]);

  if ( changes[key] === DELETED ) {
    Array.isArray(target) ? target.splice(key, 1) : delete target[key];
  }
  else if ( changes[key] === NULL ) {
    target[key] = null;
  }
			// value is the same, do nothing
  else if (target[key] === changes[key]) {
    delete changes[key];
  }
  else if ( bothAreObjects ) {
    patch(target[key], changes[key], deleteMissing);

				// no change occurred
    if ( Object.keys(changes[key]).length === 0 ) {
      delete changes[key];
    }
    else if ( deleteMissing && Array.isArray(changes[key]) ) {
      changes[key] = convertArrayToObject( changes[key] );
    }
  }
  else if ( changes[key] !== null ) {
				// update the value
    target[key] = changes[key];
  }
});
}

function convertArrayToObject(array){
  let changeObject = {};
  Object.keys(array).forEach( key => {
    if ( array[key] ) {
      changeObject[key] = array[key]
    }
  });
  return changeObject
}


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
  })
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
    [timer]: null,
    [isIkarhu]: true,
    [dispatch](property, value) {
      //console.log('dispatch', 'prop', property, 'value', value, 'stack', stack);
      if (listeners.has(obj)) {
        clearImmediate(obj[timer]);
        mergeDeep(obj[changes], {[property]: value});
        obj[timer] = setImmediate(function () {
          listeners.get(obj).forEach(function (fn) {
            fn(obj[changes]);
          });
          obj[changes] = {};
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
        let changes = {[prop] : value === null ? NULL : value};
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
export default function ikarhu(obj) {
  return new Proxy(
    enhance(obj || {}),
    Object.create(IKARHU_HANDLER)
  )
}
