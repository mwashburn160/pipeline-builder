/**
 * @module openapi/extend-zod
 * @description Eagerly extends Zod with the .openapi() method.
 *
 * In Zod 4 the extension must run BEFORE any schemas are created —
 * schemas instantiated prior to the call will NOT receive the method.
 * Import this module at the top of any file that defines Zod schemas
 * which later need .openapi() metadata (e.g. common-schemas.ts).
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);
