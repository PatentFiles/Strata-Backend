import {createHash} from 'node:crypto';
import {V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
import {WARREN_BUFFETT_SPEC} from './warrenBuffett';
export const WARREN_BOT=WARREN_BUFFETT_SPEC.id;
export const WARREN_BOT_HASH=createHash('sha256').update(JSON.stringify({
 id:WARREN_BUFFETT_SPEC.id,baseHash:V13_CHAMPION_PARAMETER_HASH,
 window:WARREN_BUFFETT_SPEC.confirmationWindowMs,gap:WARREN_BUFFETT_SPEC.maximumObservationGapMs,
 freshness:WARREN_BUFFETT_SPEC.maximumSourceAgeMs,velocity:WARREN_BUFFETT_SPEC.velocityWindowMs,
 entry:WARREN_BUFFETT_SPEC.entryParameters,exit:WARREN_BUFFETT_SPEC.exitPolicy,protocol:'WBPENDING_V1',
})).digest('hex');
