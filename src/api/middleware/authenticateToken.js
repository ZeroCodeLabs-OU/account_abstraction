import {expressjwt} from 'express-jwt';
import jwksRsa from 'jwks-rsa';

export default expressjwt({
  algorithms: ['RS256'],
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    jwksUri: "https://presence.bio/.well-known/jwks.json",
    rateLimit: true,
    jwksRequestsPerMinute: 5
  })
})
