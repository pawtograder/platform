import { App, createNodeMiddleware } from '@octokit/app';
import { createAppAuth } from '@octokit/auth-app';
import cors from 'cors';
import * as dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from "express";
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import swaggerUi from 'swagger-ui-express';
import { RegisterRoutes } from '../generated/routes.js';
import GitHubController, { getGithubPrivateKey } from './GitHubController.js';
import { ValidateError } from 'tsoa';
import { SecurityError, UserVisibleError } from './InternalTypes.js';
dotenv.config();

const app = new App({
  authStrategy: createAppAuth,
  appId: process.env.GITHUB_APP_ID || -1,
  privateKey: getGithubPrivateKey(),
  oauth: {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
  },
  webhooks: {
    secret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },
});

GitHubController.initialize(app);

const expressApp = express();
expressApp.use(express.json({ limit: '50mb' }));
expressApp.use(cors());
//@ts-ignore
expressApp.use(createNodeMiddleware(app));
RegisterRoutes(expressApp);
expressApp.use('/docs', swaggerUi.serve, async (_req: Express.Request, res: Express.Response) => {
  const swaggerSpec = await readFile('./swagger.json', 'utf-8');
  //@ts-ignore
  return res.send(swaggerUi.generateHTML(JSON.parse(swaggerSpec)));
});

//@ts-ignore
expressApp.use(function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  console.log(err);
  if (err instanceof ValidateError) {
    console.warn(`Caught Validation Error for ${req.path}:`, err.fields);
    return res.status(422).json({
      message: "Validation Failed",
      details: err?.fields,
    });
  }
  if(err instanceof SecurityError){
    console.error('Security Error:', err.details);
    return res.status(401).json({
      message: "Security Error",
      details: "This request has been reported to the staff",
    });
  }
  if(err instanceof UserVisibleError){
    return res.status(500).json({
      message: "Internal Server Error",
      details: err.details,
    });
  }
  if (err instanceof Error) {
    return res.status(500).json({
      message: "Internal Server Error",
    });
  }

  next();
});

expressApp.get('/', (req, res) => {
  // console.log(req.params)
  // console.log(req.headers)
  res.send('1Hello World!');
});

GitHubController.getInstance().initializeApp().then(() => {
  // expressApp.use(createAdminMiddleware(adminService));

  expressApp.listen(process.env.PORT || 3100, () => {
    console.log(`Server started on http://localhost:${process.env.PORT || 3100}`);
  });
})