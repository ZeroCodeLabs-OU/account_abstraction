import { expressjwt as jwt } from 'express-jwt';
import { expressJwtSecret } from 'jwks-rsa';
import dotenv from 'dotenv';
await dotenv.config();

export const authenticateToken = jwt({
  secret: expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: process.env.JWKS_URI,
  }),
  algorithms: ['RS256'],
  getToken: (req) => {
    if (req.headers.authorization && !req.headers.authorization.includes(" ")) {
      return req.headers.authorization;
    } else if (req.headers.authorization && req.headers.authorization.includes(" ")) {
      return req.headers.authorization.split(" ")[1];
    } else if (req.query && req.query.token) {
      return req.query.token;
    }
    return null;
  }
});

