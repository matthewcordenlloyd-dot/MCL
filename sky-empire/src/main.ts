import './ui/styles.css';
import './ui/ops/ops.css';
import './customiser/editors.css';
import { Game } from './core/Game';

const game = new Game(document.getElementById('app')!);
(window as unknown as { game: Game }).game = game; // handy for debugging in the console
game.start();
