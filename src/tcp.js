// Raw TCP connect, isolated in its own module so Node-based tests never have to
// import a workerd builtin. `cloudflare:sockets` is available on all plans,
// including the Free tier.
import { connect } from 'cloudflare:sockets';

export { connect };
