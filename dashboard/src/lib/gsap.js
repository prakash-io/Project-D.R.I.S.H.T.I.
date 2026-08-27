// GSAP + ScrollTrigger. One place that registers the plugin.
//
// registerPlugin must run exactly once, before any ScrollTrigger is created.
// Importing this module is what performs the registration -- ES modules are
// evaluated once per bundle, so importing it from ten components still
// registers once. Never call gsap.registerPlugin at a component's top level.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };
