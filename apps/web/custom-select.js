// Shared button/listbox control for every download selector.
export class CustomSelect {
  static openSelect = null;
  constructor(root, { label, value = '', options = [], onChange }) {
    this.root = root;
    this.label = label;
    this.value = value;
    this.options = options;
    this.onChange = onChange;
    this.open = false;
    this.typeahead = '';
    this.lastTyped = 0;
    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'select-trigger';
    this.trigger.id = `${root.id}-trigger`;
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-label', label);
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-controls', `${root.id}-options`);
    this.valueNode = document.createElement('span');
    const chevron = document.createElement('img');
    Object.assign(chevron, { src: '/assets/icons/arrow-down4.svg', alt: '', width: 15, height: 15, className: 'chevron' });
    this.trigger.append(this.valueNode, chevron);
    this.list = document.createElement('div');
    this.list.id = `${root.id}-options`;
    this.list.className = 'select-options';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', label);
    root.append(this.trigger, this.list);
    this.trigger.addEventListener('click', () => this.open ? this.close() : this.show());
    root.addEventListener('keydown', event => this.keydown(event));
    root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) this.close(); });
    document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) this.close(); });
    this.render();
  }
  setOptions(options, value = this.value) { this.options = options; this.value = value; this.render(); }
  setValue(value) { this.value = value; this.render(); }
  render() {
    this.valueNode.textContent = this.options.find(option => option.value === this.value)?.label || this.value || 'Choose';
    this.trigger.disabled = this.options.length === 0;
    this.trigger.setAttribute('aria-expanded', String(this.open));
    this.list.hidden = !this.open;
    this.list.replaceChildren();
    for (const [index, option] of this.options.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `${this.root.id}-option-${index}`;
      button.tabIndex = -1;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === this.value));
      button.disabled = !!option.disabled;
      const text = document.createElement('span');
      text.textContent = option.label;
      button.append(text);
      if (option.detail) {
        const detail = document.createElement('small');
        detail.textContent = option.detail;
        button.append(detail);
      }
      if (option.value === this.value) {
        const check = document.createElement('span');
        check.className = 'select-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
      }
      button.addEventListener('click', () => {
        this.value = option.value;
        this.close(true);
        this.render();
        this.onChange?.(option.value);
      });
      this.list.append(button);
    }
  }
  available() { return [...this.list.querySelectorAll('button:not(:disabled)')]; }
  show(last = false) {
    CustomSelect.openSelect?.close();
    CustomSelect.openSelect = this;
    this.open = true;
    this.render();
    const options = this.available();
    const selected = options.find(option => option.getAttribute('aria-selected') === 'true');
    (selected || (last ? options.at(-1) : options[0]))?.focus();
  }
  close(restoreFocus = false) {
    this.open = false;
    this.list.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (CustomSelect.openSelect === this) CustomSelect.openSelect = null;
    if (restoreFocus) this.trigger.focus();
  }
  keydown(event) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (keys.includes(event.key)) {
      event.preventDefault();
      if (!this.open) {
        this.show();
        if (event.key === 'Home') this.available()[0]?.focus();
        if (event.key === 'End') this.available().at(-1)?.focus();
      }
      else {
        const options = this.available();
        const current = options.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[index]?.focus();
      }
    } else if (event.key === 'Escape' && this.open) {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'Tab' && this.open) {
      this.close(true);
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!this.open) this.show();
      const now = Date.now();
      this.typeahead = now - this.lastTyped < 700 ? this.typeahead + event.key.toLowerCase() : event.key.toLowerCase();
      this.lastTyped = now;
      this.available().find(option => option.textContent.toLowerCase().startsWith(this.typeahead))?.focus();
    }
  }
}
