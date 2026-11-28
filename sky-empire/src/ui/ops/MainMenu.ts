import difficulty from '@data/economy/difficulty.json';
import { deleteSave, importJson, listSaves, loadGame } from '../../economy/saves';
import { money } from '../../economy/currency';
import type { Currency, Difficulty, GameState, NewGameParams } from '../../economy/types';
import { fmtDate } from './OpsCenter';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Start screen: continue, new airline (setup form), load / import a save. */
export class MainMenu {
  readonly el: HTMLElement;

  constructor(private cb: { onNew(p: NewGameParams): void; onLoad(s: GameState): void }) {
    this.el = document.createElement('div');
    this.el.id = 'mainmenu';
    this.el.className = 'hidden';
    document.body.appendChild(this.el);
  }

  async open(): Promise<void> {
    this.el.classList.remove('hidden');
    const saves = await listSaves();
    const latest = saves[0];
    this.el.innerHTML = `<div class="mm glass">
      <h1>SKY <span>EMPIRE</span></h1>
      <p class="note">Build the world's number one airline, and a billionaire's life to go with it.</p>
      <div class="mmbtns">
        ${latest ? `<button class="btn primary big" id="mmContinue">Continue<br><small>${esc(latest.airline)} · ${fmtDate(latest.simTime, true)}</small></button>` : ''}
        <button class="btn ${latest ? '' : 'primary'} big" id="mmNew">New airline</button>
        <button class="btn big" id="mmLoad" ${saves.length ? '' : 'disabled'}>Load game</button>
      </div>
      <div id="mmPanel"></div>
    </div>`;
    this.el.querySelector('#mmNew')!.addEventListener('click', () => this.newForm());
    this.el.querySelector('#mmLoad')?.addEventListener('click', () => this.loadList());
    this.el.querySelector('#mmContinue')?.addEventListener('click', async () => {
      const st = await loadGame(latest!.slot);
      if (st) this.finishLoad(st);
    });
  }

  close(): void {
    this.el.classList.add('hidden');
  }

  private finishLoad(s: GameState): void {
    this.close();
    this.cb.onLoad(s);
  }

  newForm(): void {
    const panel = this.el.querySelector<HTMLElement>('#mmPanel')!;
    const diffs = Object.entries(difficulty).filter(([k]) => !k.startsWith('_')) as [Difficulty, { label: string; cashGBP: number; fleet: { type: string; how: string; count: number }[] }][];
    panel.innerHTML = `<div class="form newgame">
      <label>Airline name <input id="ngName" maxlength="32" value="Sky Empire" required></label>
      <label>Two-letter code <input id="ngCode" maxlength="2" value="SE" style="text-transform:uppercase"></label>
      <label>Main colour <input type="color" id="ngPrimary" value="#0b2545"></label>
      <label>Accent colour <input type="color" id="ngAccent" value="#e0a526"></label>
      <label>Currency <select id="ngCur"><option>GBP</option><option>USD</option><option>EUR</option><option>ZAR</option></select></label>
      <div class="diffs">${diffs.map(([k, d], i) => `<label class="diff glass"><input type="radio" name="ngDiff" value="${k}" ${i === 1 ? 'checked' : ''}>
        <b>${d.label}</b><small>${k === 'sandbox' ? 'Unlimited money, no slot limits' : `${money(d.cashGBP / 0.79, 'GBP')} · ${d.fleet.map((f) => `${f.count} ${f.how === 'own' ? 'owned' : 'leased'} ${f.type.toUpperCase()}`).join(', ')}`}</small></label>`).join('')}</div>
      <p class="note">You start at London Gatwick. Heathrow slots must be bought (Easy gives you a few).</p>
      <button class="btn primary big" id="ngStart">Found the airline</button></div>`;
    panel.querySelector('#ngStart')!.addEventListener('click', () => {
      const v = (id: string) => (panel.querySelector(`#${id}`) as HTMLInputElement).value;
      const p: NewGameParams = {
        airlineName: v('ngName').trim() || 'Sky Empire',
        code: (v('ngCode').trim() || 'SE').toUpperCase(),
        primary: v('ngPrimary'),
        accent: v('ngAccent'),
        currency: v('ngCur') as Currency,
        difficulty: (panel.querySelector('input[name="ngDiff"]:checked') as HTMLInputElement).value as Difficulty,
      };
      this.close();
      this.cb.onNew(p);
    });
  }

  async loadList(): Promise<void> {
    const panel = this.el.querySelector<HTMLElement>('#mmPanel')!;
    const saves = await listSaves();
    panel.innerHTML = `<table class="saves">${saves.map((s) => `<tr><td><b>${esc(s.slot)}</b><br><small>${esc(s.airline)} · ${s.difficulty}</small></td>
      <td>${fmtDate(s.simTime, true)}</td><td>${money(s.cashUSD, 'GBP')}</td><td><small>saved ${new Date(s.savedAt).toLocaleString('en-GB')}</small></td>
      <td><button class="btn sm primary" data-load="${esc(s.slot)}">Load</button> <button class="btn sm" data-del="${esc(s.slot)}">Delete</button></td></tr>`).join('')}</table>
      <label class="btn">Import a save file (JSON) <input type="file" id="mmImport" accept=".json,application/json" hidden></label>`;
    panel.querySelectorAll<HTMLElement>('[data-load]').forEach((b) => b.addEventListener('click', async () => {
      const st = await loadGame(b.dataset.load!);
      if (st) this.finishLoad(st);
    }));
    panel.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Delete the save "${b.dataset.del}"? This cannot be undone.`)) return;
      await deleteSave(b.dataset.del!);
      this.loadList();
    }));
    panel.querySelector<HTMLInputElement>('#mmImport')!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        this.finishLoad(await importJson(f));
      } catch (err) {
        alert((err as Error).message);
      }
    });
  }
}
