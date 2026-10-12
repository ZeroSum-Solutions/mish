import type { BriefCase } from './types.ts';
export const DEFAULT_KIT = 'user:atlas-sage-space-tl02';
const BRIGHTWATER_BRIEF = "Client: Brightwater Family Dental (fictional demo client), a two-dentist practice in Portland, Oregon.\nGoal: a warm, calm site that gets new patients to book a first visit online.\nAudience: busy parents and adults who are nervous about the dentist.\nPages: Home, Services (cleanings, kids' dentistry, Invisalign, emergency care), About the team, Book a visit.\nTone: friendly, plain words, no clinical jargon. Highlight evening hours and same-week appointments.";
const FACTS: Record<string, Pick<BriefCase, 'suppliedFacts' | 'omittedFacts' | 'conversion'>> = {
  dental: {
    suppliedFacts: { name: 'Linden Dental Studio', location: 'Portland', audience: 'Adults who feel anxious about appointments', services: ['preventive care', 'restorative dentistry', 'cosmetic consultations'], direction: 'Calm, welcoming first visit; warm editorial photography' },
    omittedFacts: ['reviews', 'awards', 'prices', 'clinician credentials', 'clinical outcomes', 'contact details'],
    conversion: { action: 'Request an appointment through a local demo; never book or send', labels: ['request an appointment', 'appointment', 'first visit', 'book'], destinationRoles: ['contact', 'booking'], demoOnly: true },
  },
  restaurant: {
    suppliedFacts: { name: 'Hearth & Tide', location: 'Seattle', audience: 'Friends planning a relaxed dinner', offer: 'Neighbourhood seasonal restaurant', direction: 'Tactile ingredients, table scenes and quiet warmth', menu: 'Clearly labelled fictional sample seasonal menu' },
    omittedFacts: ['awards', 'reviews', 'sourced ingredients', 'contact details', 'reservation availability'],
    conversion: { action: 'Enquire about a table locally; never hold, charge or send', labels: ['table', 'enquire', 'reservation'], destinationRoles: ['contact', 'booking'], demoOnly: true },
  },
  law: {
    suppliedFacts: { name: 'Alder Legal', location: 'Denver', audience: 'Small business owners', services: ['contracts', 'business formation', 'initial consultation'], direction: 'Restrained precise identity; architectural imagery and plain language' },
    omittedFacts: ['bar memberships', 'case outcomes', 'testimonials', 'fees', 'guarantees', 'contact details'],
    conversion: { action: 'Request a consultation locally; never deliver a message', labels: ['consultation', 'request'], destinationRoles: ['contact', 'booking'], demoOnly: true },
  },
  saas: {
    suppliedFacts: { name: 'Relayboard', audience: 'Small operations teams losing decisions between shifts', product: 'Team handoff software', examples: ['labelled sample interface data', 'shift handoff', 'activity timeline'], direction: 'Distinct orderly editorial layout and product illustrations' },
    omittedFacts: ['customers', 'usage metrics', 'security certifications', 'pricing', 'contact details'],
    conversion: { action: 'Request a demo through a local form; never send', labels: ['demo', 'request'], destinationRoles: ['contact', 'booking'], demoOnly: true },
  },
  fitness: {
    suppliedFacts: { name: 'Common Ground Strength', location: 'Austin', audience: 'Beginners seeking supportive small-group strength training', services: ['introductory sessions', 'progressive coaching'], timetable: 'Weekly sample timetable', direction: 'Energetic inclusive imagery' },
    omittedFacts: ['coach credentials', 'transformations', 'testimonials', 'prices', 'contact details'],
    conversion: { action: 'Enquire about an introductory session locally; never hold, charge or send', labels: ['introductory', 'session', 'enquire'], destinationRoles: ['contact', 'booking'], demoOnly: true },
  },
  brightwater: {
    suppliedFacts: { name: 'Brightwater Family Dental', location: 'Portland, Oregon', practice: 'Fictional two-dentist practice', audience: ['busy parents', 'adults nervous about the dentist'], services: ['cleanings', "kids’ dentistry", 'Invisalign', 'emergency care'], availability: ['evening hours', 'same-week appointments'], tone: 'Warm, calm, friendly plain words without clinical jargon' },
    omittedFacts: ['dentist identities and credentials', 'reviews', 'prices', 'street address', 'phone number', 'exact opening hours', 'real booking endpoint'],
    conversion: { action: 'Lead new patients to Book a visit; this benchmark cannot make a real booking', labels: ['book', 'visit', 'appointment'], destinationRoles: ['booking'], demoOnly: true },
  },
};

/**
 * Improve prompt cases (2026-10-10 design eval). Client-style requests, not briefs: `compare --writers`
 * builds each one from the request alone and from each Improve prompt writer's brief. `requirements`
 * must reach the page, `omittedFacts` must not be stated as fact, and `questions` are gaps a good
 * brief raises. All are dev cases; none is a holdout.
 */
const IMPROVE_PROMPT_CASES: readonly BriefCase[] = Object.freeze([
  { id: 'bakery-preorder', industry: 'bakery', kitId: 'neutral-product', suite: 'improve-prompt' as const,
    brief: "Landing page for Rise & Crumb, a small sourdough bakery in Austin. We're open Tuesday to Sunday and closed Mondays. The main goal is weekend pre-orders for pickup. Use Fraunces for headings and Inter for body text. Warm and rustic, cream and toasted-brown colors, no stock-photo look. We haven't set prices yet, so don't show any. It must work well on phones.",
    suppliedFacts: { name: "Rise & Crumb", requirements: ["The bakery is named Rise & Crumb and is in Austin", "Open Tuesday to Sunday and closed on Mondays", "The main call to action is pre-ordering for weekend pickup", "Fraunces is the heading font", "Inter is the body text font", "A warm, rustic look with cream and toasted-brown colors", "Avoid a stock-photo look", "No prices are shown", "Designed to work well on phones"] },
    omittedFacts: ["A specific price for any product", "A street address, phone number or email address", "Specific opening or closing clock times", "A founding year, award, customer count or testimonial"],
    questions: ["How pre-orders are placed or how pickup works (method, time windows or deadlines)", "Which products or menu items to feature"],
    conversion: { action: "Pre-order for weekend pickup through a local demo; never take an order or payment", labels: ["pre-order", "preorder", "order"], destinationRoles: ["contact", "booking"], demoOnly: true } },
  { id: 'saas-invoicing', industry: 'SaaS', kitId: 'neutral-product', suite: 'improve-prompt' as const,
    brief: "Marketing site for Ledgerly, invoicing software for independent plumbers and electricians in the US. Main call to action: start a free 14-day trial, no credit card required. Bold and high-contrast, trustworthy, not playful. Sections: hero, how it works in three steps, pricing with two plans (we'll give the prices later), and an FAQ. Built with Next.js and Tailwind. No testimonials until we have real ones.",
    suppliedFacts: { name: "Ledgerly", requirements: ["The product is Ledgerly, invoicing software", "The audience is independent plumbers and electricians in the US", "The main call to action is a free 14-day trial with no credit card required", "A bold, high-contrast, trustworthy style that is not playful", "A hero section", "A how-it-works section with three steps", "A pricing section with two plans", "An FAQ section", "Built with Next.js and Tailwind", "No testimonials"] },
    omittedFacts: ["A specific price for either plan", "A customer count, revenue figure, rating or other statistic", "A testimonial, quote or named customer", "Names for the two plans"],
    questions: ["The plan prices or what each plan includes", "What the FAQ should answer"],
    conversion: { action: "Start a free 14-day trial through a local demo; never create an account", labels: ["trial", "start free", "free trial"], destinationRoles: ["contact", "booking"], demoOnly: true } },
  { id: 'win95-portfolio', industry: 'portfolio', kitId: 'neutral-product', suite: 'improve-prompt' as const,
    brief: "Portfolio for Maya Ortiz, a freelance motion designer. Make it look like Windows 95: gray bevelled windows, a taskbar with a Start button, pixel icons. Each case study opens as a draggable window with an embedded video. Include a contact form. Respect reduced-motion settings.",
    suppliedFacts: { name: "Maya Ortiz", requirements: ["The portfolio belongs to Maya Ortiz, a freelance motion designer", "A Windows 95 look, not a modern or minimal style", "Gray bevelled windows", "A taskbar with a Start button", "Pixel icons", "Each case study opens as a draggable window", "Case studies embed a video", "A contact form", "Reduced-motion settings are respected"] },
    omittedFacts: ["Names of clients, brands or employers", "Titles of specific case studies or projects", "Awards, years of experience or other credentials"],
    questions: ["Which case studies or videos to include, or where the videos are hosted", "Where contact form submissions should go"],
    conversion: { action: "Send a message through the local contact form; never deliver it", labels: ["contact", "message"], destinationRoles: ["contact"], demoOnly: true } },
  { id: 'clinic-access', industry: 'physical therapy', kitId: 'neutral-product', suite: 'improve-prompt' as const,
    brief: "Website for Northside Physical Therapy, a clinic for adults over 60 recovering from hip and knee surgery. It has to be very easy to read: large text, high contrast, big buttons, no carousels, nothing that plays automatically. Pages: services, our therapists, insurance we accept, and book an appointment online. Calm blues and greens.",
    suppliedFacts: { name: "Northside Physical Therapy", requirements: ["The clinic is Northside Physical Therapy", "The audience is adults over 60 recovering from hip and knee surgery", "Large text", "High contrast", "Big buttons", "No carousels", "Nothing plays automatically", "A services page", "An our-therapists page", "An insurance-accepted page", "Online appointment booking", "Calm blues and greens"] },
    omittedFacts: ["Names or credentials of specific therapists", "Names of specific insurance companies or plans", "A street address, phone number or opening hours"],
    questions: ["Which insurance plans are accepted", "Therapist details or how online booking works (booking system)"],
    conversion: { action: "Book an appointment online through a local demo; never book or send", labels: ["book", "appointment"], destinationRoles: ["booking", "contact"], demoOnly: true } },
  { id: 'warehouse-dashboard', industry: 'internal dashboard', kitId: 'neutral-product', suite: 'improve-prompt' as const,
    brief: "Internal dashboard in Vue 3 for our warehouse team: an inventory table with search and filters, low-stock alerts at the top, and a map of today's shipments. Dense and data-first, dark mode by default with a light mode toggle. Keyboard shortcuts for search and filters. It runs on 1080p monitors in the warehouse, so no mobile layout is needed.",
    suppliedFacts: { name: "Warehouse team dashboard", requirements: ["Built with Vue 3", "An inventory table with search and filters", "Low-stock alerts at the top", "A map of today's shipments", "A dense, data-first layout", "Dark mode by default", "A light mode toggle", "Keyboard shortcuts for search and filters", "Targets 1080p desktop monitors, and no mobile layout is required"] },
    omittedFacts: ["Specific product names, SKUs or stock quantities", "A specific numeric low-stock threshold", "A company or warehouse name"],
    questions: ["What counts as low stock (the threshold) or where the data comes from", "Which filters or columns the inventory table needs"],
    conversion: { action: "Search and filter the inventory table; internal tool with no outbound action", labels: ["search", "filter"], destinationRoles: [], demoOnly: true } },
].map(item => Object.freeze({ ...item, split: 'dev' as const })));

/** Frozen fictional inputs. Changes invalidate baseline comparisons. */
export const CASES: readonly BriefCase[] = Object.freeze([...[
  { id: 'dental', industry: 'dental', kitId: DEFAULT_KIT, brief: 'Create a four-page site for fictional Linden Dental Studio in Portland: home, services, about, contact. Audience: adults who put off appointments because they feel anxious. Offer preventive care, restorative dentistry and cosmetic consultations. Lead with a calm, welcoming first visit. Use considered photography and a warm editorial treatment. Primary action: request an appointment. Explain what happens at the visit. Contact form is a local demo: never claim an appointment is booked or a message sent. Do not invent reviews, awards, prices, clinician credentials or clinical outcomes.' },
  { id: 'restaurant', industry: 'restaurant', kitId: DEFAULT_KIT, brief: 'Create a four-page site for fictional Hearth & Tide, a neighbourhood seasonal restaurant in Seattle: home, menu, story, visit. Audience: friends planning a relaxed dinner. Art direction: tactile ingredients, table scenes and quiet warmth. Show a sample seasonal menu clearly labelled as fictional. Primary action: enquire about a table through a local demo. Do not claim a reservation is held, a payment taken or an enquiry sent. Do not invent awards, reviews or sourced ingredients.' },
  { id: 'law', industry: 'law firm', kitId: DEFAULT_KIT, brief: 'Create a four-page site for fictional Alder Legal in Denver: home, services, about, contact. Audience: small business owners looking for clear contract and business-formation advice. Use a restrained, precise identity with thoughtful architectural imagery. Explain the initial consultation and scope of services in plain language. Primary action: request a consultation through a local demo. Do not invent bar memberships, case outcomes, testimonials, fees or guarantees. Never claim a message was delivered.' },
  { id: 'saas', industry: 'SaaS', kitId: DEFAULT_KIT, brief: 'Create a four-page site for fictional Relayboard, a team handoff software product: home, product, about, contact. Audience: small operations teams losing decisions between shifts. Show believable product-interface illustrations, explain a shift handoff and illustrate an activity timeline. Use a distinct, orderly editorial layout. Primary action: request a demo through a local form. Label sample interface data. Do not invent customers, usage metrics, security certifications or pricing. Never claim a request was sent.' },
  { id: 'fitness', industry: 'fitness', kitId: DEFAULT_KIT, brief: 'Create a four-page site for fictional Common Ground Strength in Austin: home, programmes, coaches, visit. Audience: beginners who want a supportive small-group strength studio. Use energetic, inclusive imagery and a clear weekly sample timetable. Describe introductory sessions and progressive coaching. Primary action: enquire about an introductory session through a local demo. Do not invent coach credentials, transformations, testimonials or prices. Never imply a held place, payment or sent message.' },
  { id: 'brightwater', industry: 'dental', kitId: DEFAULT_KIT,
    brief: BRIGHTWATER_BRIEF, regressionAnchor: true,
    sourcePath: '<private-inbox>/screenshots/flagship-demo-2026-10-09/atlas-ui/evidence.json' },
].map(item => Object.freeze({ ...item, ...FACTS[item.id]!, split: 'dev' as const })), ...IMPROVE_PROMPT_CASES]);

/**
 * Cases by id (comma-separated) or, without ids, every case of `suite` in `split`. Agency cases have no
 * `suite` field, so their bytes and fixture digests are unchanged by the improve-prompt suite.
 */
export function selectCases(caseId?: string, kitId?: string, split: BriefCase['split'] = 'dev', suite: 'agency' | 'improve-prompt' = 'agency'): BriefCase[] {
  const ids = caseId?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  const inSuite = (item: BriefCase) => (item.suite ?? 'agency') === suite;
  const selected = CASES.filter(item => item.split === split && (ids.length ? ids.includes(item.id) : inSuite(item))).map(item => ({ ...item, kitId: kitId ?? item.kitId }));
  if (!selected.length || selected.length !== (ids.length || selected.length)) throw new Error('Unknown case');
  return selected;
}
