import { join } from 'path';
import { promises as fsPromises } from 'fs';
import { error } from 'console';

const { writeFile } = fsPromises;

const pathCommonJs = join('build', 'cjs', 'package.json');
const pathEsm = join('build', 'esm', 'package.json');

const run = async () => {
  await Promise.all([
    writeFile(
      pathCommonJs,
      JSON.stringify(
        {
          type: 'commonjs',
        },
        undefined,
        2
      ),
      'utf-8'
    ),
    writeFile(
      pathEsm,
      JSON.stringify(
        {
          type: 'module',
        },
        undefined,
        2
      ),
      'utf-8'
    ),
  ]);
};

run()
  .then()
  .catch((err) => error(err));
