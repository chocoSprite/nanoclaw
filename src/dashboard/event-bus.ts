/**
 * Re-export of the in-process event bus for dashboard-internal consumers.
 * Keeps dashboard modules from directly reaching into `../agent-events.js`
 * so the dependency boundary stays explicit.
 */
export {
  agentEvents,
  InProcessEventBus,
  type AgentEventBus,
} from '../agent-events.js';
