import { OPENAPI_BASE } from './openapi/common';
import { FILESPaths } from './openapi/files';
import { LIFECYCLEPaths } from './openapi/lifecycle';
import { PROCESSESPaths } from './openapi/processes';
import { TERMINALSPaths } from './openapi/terminals';

export const OPENAPI_SCHEMA = {
  ...OPENAPI_BASE,
  paths: {
    ...LIFECYCLEPaths,
    ...PROCESSESPaths,
    ...FILESPaths,
    ...TERMINALSPaths
  }
} as const;
