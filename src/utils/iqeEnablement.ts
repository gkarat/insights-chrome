/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable prefer-rest-params */
import type { Store } from 'redux';
import { setGatewayError } from '../redux/actions';
import { get3scaleError } from './responseInterceptors';
import crossAccountBouncer from '../auth/crossAccountBouncer';
// eslint-disable-next-line no-restricted-imports
import type { AuthContextProps } from 'react-oidc-context';
// TODO: Refactor this file to use modern JS

let xhrResults: XMLHttpRequest[] = [];
let fetchResults: Record<string, unknown> = {};

const DENIED_CROSS_CHECK = 'Access denied from RBAC on cross-access check';
const AUTH_ALLOWED_ORIGINS = [location.origin, 'https://api.openshift.com', 'https://api.stage.openshift.com'];
const AUTH_EXCLUDED_URLS = ['https://api.openshift.com/api/upgrades_info/', 'https://api.stage.openshift.com/api/upgrades_info/'];

const isExcluded = (target: string) => {
  return AUTH_EXCLUDED_URLS.some((url) => target.includes(url));
};

const verifyTarget = (originMatch: string, urlMatch: string) => {
  return AUTH_ALLOWED_ORIGINS.some((origin) => originMatch.includes(origin)) && !isExcluded(urlMatch);
};

const shouldInjectAuthHeaders = (path: URL | Request | string = '') => {
  if (path instanceof URL) {
    // the type URL has a different match function than the cases above
    return AUTH_ALLOWED_ORIGINS.includes(path.origin) && !isExcluded(path.href);
  } else if (path instanceof Request) {
    return verifyTarget(path.url, path.url);
  } else if (typeof path === 'string') {
    return verifyTarget(path, path) || !path.startsWith('http');
  }

  return true;
};

const spreadAdditionalHeaders = (options: RequestInit | undefined) => {
  let additionalHeaders: any = {};
  if (options && options.headers) {
    if (Array.isArray(options.headers)) {
      for (const el in options.headers) {
        additionalHeaders[options.headers[el][0]] = options.headers[el].slice(1).join(', ');
      }
    } else {
      additionalHeaders = options.headers;
    }
  }

  return additionalHeaders;
};

export function init(store: Store, authRef: React.MutableRefObject<AuthContextProps>) {
  const open = window.XMLHttpRequest.prototype.open;
  const send = window.XMLHttpRequest.prototype.send;
  const setRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;
  const oldFetch = window.fetch;
  const authRequests = new Set();
  fetchResults = {};

  const iqeEnabled = window.localStorage && window.localStorage.getItem('iqe:chrome:init') === 'true';

  if (iqeEnabled) {
    console.log('[iqe] initialized'); // eslint-disable-line no-console
  }

  // must use function here because arrows dont "this" like functions
  window.XMLHttpRequest.prototype.open = function openReplacement(_method, url) {
    // @ts-ignore
    this._url = url;
    // @ts-ignore
    const req = open.apply(this, arguments);

    return req;
  };

  window.XMLHttpRequest.prototype.setRequestHeader = function serRequestHeaderReplacement() {
    if (arguments[0] === 'Authorization') {
      authRequests.add((this as XMLHttpRequest & { _url: string })._url);
    }

    // if the header is Auth change it to Authorization, since that's our internal name
    // @ts-ignore
    return setRequestHeader.apply(this, [arguments[0] === 'Auth' ? 'Authorization' : arguments[0], arguments[1]]);
  };

  // must use function here because arrows dont "this" like functions
  window.XMLHttpRequest.prototype.send = function sendReplacement() {
    if (shouldInjectAuthHeaders((this as XMLHttpRequest & { _url: string })._url)) {
      if (!authRequests.has((this as XMLHttpRequest & { _url: string })._url)) {
        // Send Auth header, it will be changed to Authorization later down the line
        this.setRequestHeader('Auth', `Bearer ${authRef.current.user?.access_token}`);
      }
    }
    // eslint-disable-line func-names
    if (iqeEnabled) {
      xhrResults.push(this);
    }
    this.onload = function () {
      if (this.status >= 400) {
        const gatewayError = get3scaleError(this.response);
        if (this.status === 403 && this.responseText.includes(DENIED_CROSS_CHECK)) {
          crossAccountBouncer();
          // check for 3scale error
        } else if (gatewayError) {
          store.dispatch(setGatewayError(gatewayError));
        }
      }
    };
    // @ts-ignore
    return send.apply(this, arguments);
  };

  /**
   * Check response errors for cross_account requests.
   * If we get error response with specific cross account error message, we kick the user out of the corss account session.
   */
  window.fetch = function fetchReplacement(input: URL | RequestInfo = '', init?: RequestInit | undefined, ...rest) {
    const tid = Math.random().toString(36);
    const request: Request = new Request(input, init);

    if (shouldInjectAuthHeaders(input) && !request.headers.has('Authorization')) {
      request.headers.append('Authorization', `Bearer ${authRef.current.user?.access_token}`);
    }

    const prom = oldFetch.apply(this, [request, ...rest]);
    if (iqeEnabled) {
      fetchResults[tid] = arguments[0];
      prom
        .then(function () {
          delete fetchResults[tid];
        })
        .catch(function (err) {
          delete fetchResults[tid];
          throw err;
        });
    }
    return prom
      .then(async (res) => {
        const resCloned = res.clone();
        if (!res.ok) {
          try {
            const isJson = resCloned?.headers?.get('content-type')?.includes('application/json');
            const data = isJson ? await resCloned.json() : await resCloned.text();
            const gatewayError = get3scaleError(data);
            if (gatewayError) {
              store.dispatch(setGatewayError(gatewayError));
            }

            return res;
          } catch (error) {
            console.error('unable to check unauthotized response', error);
            return res;
          }
        }
        return res;
      })
      .catch((err) => {
        console.log(err);
        throw err;
      });
  };
}

const qe = {
  init,
  spreadAdditionalHeaders,
  hasPendingAjax: () => {
    const xhrRemoved = xhrResults.filter((result) => result.readyState === 4 || result.readyState === 0);
    xhrResults = xhrResults.filter((result) => result.readyState !== 4 && result.readyState !== 0);
    // @ts-ignore
    xhrRemoved.map((e) => console.log(`[iqe] xhr complete:   ${e._url}`));
    // @ts-ignore
    xhrResults.map((e) => console.log(`[iqe] xhr incomplete: ${e._url}`));
    Object.values(fetchResults).map((e) => console.log(`[iqe] fetch incomplete: ${e}`));

    return xhrResults.length > 0 || Object.values(fetchResults).length > 0;
  },
  isPageSafe: () => document.querySelectorAll('[data-ouia-safe=false]').length === 0,
  xhrResults: () => {
    return xhrResults;
  },
  fetchResults: () => {
    return fetchResults;
  },
};

export default qe;
