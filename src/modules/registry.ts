// Static create-module registry, spec 2.9. Order: Shapes 0, Speed 2, then alphabetical.
import type { CreateModule } from '../engine/engine';
import { detachShapes } from './create/detach';
import { pressureShapes } from './create/pressure';
import { scrawlShapes } from './create/scrawl';
import { shapes } from './create/shapes';
import { speedShapes } from './create/speed';

export interface ModuleDescriptor {
  readonly id: string;
  readonly kind: 'create';
  readonly order: number;
  make(): CreateModule;
}

export const createModules: readonly ModuleDescriptor[] = [
  { id: 'create.shapes', kind: 'create', order: 0, make: shapes },
  { id: 'create.speedShapes', kind: 'create', order: 2, make: speedShapes },
  { id: 'create.detachShapes', kind: 'create', order: 101, make: detachShapes },
  { id: 'create.pressureShapes', kind: 'create', order: 102, make: pressureShapes },
  { id: 'create.scrawlShapes', kind: 'create', order: 103, make: scrawlShapes },
];
