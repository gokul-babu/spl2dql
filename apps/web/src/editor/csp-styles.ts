import { StyleModule } from 'style-mod';

/**
 * CodeMirror injects its base styles with a <style> element, which a strict Content-Security-Policy
 * (style-src 'self', no 'unsafe-inline') blocks. Constructable stylesheets are CSSOM and are allowed,
 * so CodeMirror's style modules are mounted into one adopted sheet instead. Import this module before
 * any editor is created.
 */
type MountFn = typeof StyleModule.mount;

const sheet = typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in Document.prototype ? new CSSStyleSheet() : undefined;
const mounted = new WeakSet<StyleModule>();
const original: MountFn = StyleModule.mount.bind(StyleModule);

if (sheet) {
  document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets];
  StyleModule.mount = ((root: Document | ShadowRoot, modules: StyleModule | readonly StyleModule[], options?: { nonce?: string }) => {
    if (root !== document) return original(root, modules as StyleModule | StyleModule[], options);
    for (const mod of Array.isArray(modules) ? modules : [modules as StyleModule]) {
      if (mounted.has(mod)) continue;
      mounted.add(mod);
      for (const rule of (mod as unknown as { rules: string[] }).rules) {
        try {
          sheet.insertRule(rule, sheet.cssRules.length);
        } catch {
          // A rule the browser does not understand is skipped, as a <style> element would.
        }
      }
    }
  }) as MountFn;
}
