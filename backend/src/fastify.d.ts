import '@fastify/cookie';
import '@fastify/multipart';
import 'fastify';

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AuthenticatedUser } from './services/auth';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: AuthenticatedUser | null;
    sessionToken: string | null;
  }

  interface FastifyReply {
    setCookie(name: string, value: string, options?: CookieSerializeOptions): this;
    clearCookie(name: string, options?: CookieSerializeOptions): this;
  }
}
