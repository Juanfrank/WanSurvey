import { generateVapidKeys } from './webpush.js';

/** Prints a new VAPID key pair for the settings VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. */
const k = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
console.log('VAPID_SUBJECT=mailto:<an address that reaches whoever runs the service>');
