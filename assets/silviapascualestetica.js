/**
 * <scheduled-badge data-start="unix_seconds" data-end="unix_seconds">
 *
 * Etiqueta programada del grid de productos. Se muestra solo entre data-start y data-end
 * (cualquiera de los dos es opcional) y se actualiza sola al llegar la hora de inicio o fin,
 * sin necesidad de recargar la página.
 */
if (!window.customElements.get('scheduled-badge')) {
  class ScheduledBadge extends HTMLElement {
    connectedCallback() {
      this.start = this.dataset.start ? parseInt(this.dataset.start, 10) * 1000 : null;
      this.end = this.dataset.end ? parseInt(this.dataset.end, 10) * 1000 : null;
      this.update();
    }

    disconnectedCallback() {
      clearTimeout(this.timer);
    }

    update() {
      clearTimeout(this.timer);

      const now = Date.now();
      const started = this.start === null || now >= this.start;
      const ended = this.end !== null && now >= this.end;

      this.hidden = !started || ended;

      // Programar el siguiente cambio (inicio o fin). setTimeout admite como máximo ~24,8 días.
      const next = !started ? this.start : (!ended && this.end !== null ? this.end : null);

      if (next !== null) {
        this.timer = setTimeout(() => this.update(), Math.min(next - now + 50, 2147483647));
      }
    }
  }

  window.customElements.define('scheduled-badge', ScheduledBadge);
}
