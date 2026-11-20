/**
 * Marks the SDK's own upload requests. The XHR tracker skips any request
 * that carries it, so an upload never records itself as a resource and
 * never feeds the next upload.
 */
export const INTERNAL_REQUEST = '__oodleInternalRequest';
