// Agents › Space: the fleet in 3D (docs/specs/2026-11-21-cohesion-overhaul.md, "Space"). A placeholder with the view
// interface every view has (README "Views", the view interface); the 3D view replaces this file and keeps it.
import { block, hints } from '../ui.js';

export class SpaceView {
  constructor(app) { this.app = app; this.id = 'space'; this.title = 'Space'; }
  show() {}
  hide() {}
  render(width, height) { return block([[[' 3D view: coming in this branch', 'dim']]], height); }
  key() { return false; }
  mouse() { return false; }
  hints() { return hints([['< >', 'views'], ['?', 'help']]); }
}
