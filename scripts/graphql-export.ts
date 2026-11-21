/**
 * Exporta a archivos .graphql el contrato GraphQL que valida graphql-inspector en CI.
 *
 *   <out>/schema.graphql          esquema del gateway (services/graphql-gateway/src/schema.ts)
 *   <out>/operations/*.graphql    cada query, mutation y subscription del frontend
 *                                 (apps/frontend/src/graphql.ts), ya con las interpolaciones resueltas
 *   <out>/base-schema.graphql     solo si se pasa [baseSchemaTs]: el esquema de la rama destino
 *
 * Uso (Node 24+, ejecuta TypeScript sin compilar):
 *   node scripts/graphql-export.ts <out> [baseSchemaTs]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const [outArg, baseSchemaArg] = process.argv.slice(2);
if (!outArg) {
  console.error('uso: node scripts/graphql-export.ts <out> [baseSchemaTs]');
  process.exit(2);
}
const out = resolve(outArg);

// "graphql" se resuelve desde el frontend (pnpm no lo instala en la raíz).
const requireFromFrontend = createRequire(join(root, 'apps/frontend/package.json'));
const { print, buildSchema, printSchema } = (await import(
  pathToFileURL(requireFromFrontend.resolve('graphql')).href
)) as typeof import('graphql');

const load = async (file: string) => import(pathToFileURL(resolve(root, file)).href);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'operations'), { recursive: true });

// buildSchema falla aquí mismo si el SDL es inválido.
const sdl = async (file: string) => printSchema(buildSchema((await load(file)).typeDefs as string));

writeFileSync(join(out, 'schema.graphql'), `${await sdl('services/graphql-gateway/src/schema.ts')}\n`);
if (baseSchemaArg) writeFileSync(join(out, 'base-schema.graphql'), `${await sdl(baseSchemaArg)}\n`);

const docs = await load('apps/frontend/src/graphql.ts');
let count = 0;
for (const [name, value] of Object.entries(docs)) {
  if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'Document') {
    writeFileSync(join(out, 'operations', `${name}.graphql`), `${print(value as never)}\n`);
    count++;
  }
}
if (count === 0) {
  console.error('No se encontró ningún documento GraphQL en apps/frontend/src/graphql.ts');
  process.exit(1);
}
console.log(`schema.graphql + ${count} operaciones del frontend en ${out}${baseSchemaArg ? ' (+ base-schema.graphql)' : ''}`);
