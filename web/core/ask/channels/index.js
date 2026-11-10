// The ask channels, each one module with the same surface: NAME, missing(env), configured(env), send({text, asks}),
// health(); inbound comes through readUpdate / readInbound / readMessage into the router (core/ask/router.js).
import * as telegram from './telegram.js';
import * as imessage from './imessage.js';
import * as sms from './sms.js';

export const ADAPTERS = Object.freeze({ telegram, imessage, sms });

/** The channels this host could use now (configured), in the given order. */
export const usableChannels = (order, adapters = ADAPTERS, env = process.env) => order.filter((c) => adapters[c]?.configured(env));
