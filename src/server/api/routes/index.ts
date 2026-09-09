import { Router } from 'express';
import { authRouter } from './auth';
import { statsRouter } from './stats';
import { factsRouter } from './facts';
import { settingsRouter } from './settings';
import { pluginsRouter } from './plugins';
import { modelsRouter } from './models';
import { channelsRouter } from './channels';
import { controllersRouter } from './controllers';
import { requireAuth } from '../middleware/requireAuth';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/stats', requireAuth, statsRouter);
apiRouter.use('/facts', requireAuth, factsRouter);
apiRouter.use('/settings', requireAuth, settingsRouter);
apiRouter.use('/plugins', requireAuth, pluginsRouter);
apiRouter.use('/models', requireAuth, modelsRouter);
apiRouter.use('/channels', requireAuth, channelsRouter);
apiRouter.use('/controllers', requireAuth, controllersRouter);
