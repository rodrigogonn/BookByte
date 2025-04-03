import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    res.status(401).send({ message: 'No token provided.' });
    return;
  }

  const tokenParts = authHeader.split(' ');
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    res.status(401).send({ message: 'Invalid authorization header.' });
    return;
  }

  const token = tokenParts[1];

  try {
    jwt.verify(token, process.env.JWT_SECRET || '');
    next();
    return;
  } catch {
    res.status(401).send({ message: 'Invalid token.' });
    return;
  }
};
