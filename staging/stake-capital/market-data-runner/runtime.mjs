import {capture} from './capture.mjs';
import {bindPublicBookSocket} from './ws-adapter.mjs';
import {makeFixedTlsDial} from './tls-dial.mjs';
export const run=(ticker,providers)=>capture({ticker,openReadOnly:bindPublicBookSocket({dial:makeFixedTlsDial(),...providers})});
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)
 console.log(JSON.stringify(await run(process.env.KALSHI_BOOK_TICKER)));
