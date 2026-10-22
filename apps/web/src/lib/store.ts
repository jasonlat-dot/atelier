import {useSyncExternalStore} from 'react';
import {subscribe,snapshot} from './mockDb';
export function useDemoDB(){return useSyncExternalStore(subscribe,snapshot,snapshot);}
