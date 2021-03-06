import * as Router from 'koa-router';
import * as oauth2orize from 'oauth2orize-koa';
import * as passport from 'koa-passport';
import oauth2models from './oauth2models';
import { models, addModel } from './orm';
import { createUser, getUser } from './auth';
import secret from '../support/secret';
import inflector from '../support/inflector';
import debug from '../support/debug';

/**
 * @ignore
 */
const BasicStrategy = require('passport-http').BasicStrategy,
	ClientStrategy = require('passport-oauth2-client-password').Strategy,
	BearerStrategy = require('passport-http-bearer').Strategy,
	server = oauth2orize.createServer();

/**
 * Indicate which model to use as Authorization Model, this can be configured in config/security.js#model
 * @type {CaminteJSModel}
 */
export let AuthModel = models[inflector.pluralize(configuration.security.model)];
/**
 * Creates a autorize-koa server and set it up ussing passport<br/>
 * Default implemented strategies are:
 * <ol><li>BasicStrategy</li>
 * <li>ClientStrategy</li>
 * <li>BearerStrategy</li></ol>
 * @return {KoaRouter} Aouth2ServerMiddleware - Default routes append are /singin /token/ /singup /singout
 */
export function oauth2server () {
	AuthModel = models[inflector.pluralize(configuration.security.model)];
	for (let model in oauth2models) {
		addModel(inflector.pluralize(model), oauth2models[model]);
	}
	const router = new Router();
	passport.use(new BasicStrategy(getUser));
	passport.use(new ClientStrategy(getUser));
	passport.use(new BearerStrategy(function (token, done) {
		return models.oauth2accesstokens.rawAPI.findOne({
			where: {
				Token: token
			}
		}).then(accesstoken => {
			/* istanbul ignore else */
			if (accesstoken !== null) {
				if (accesstoken.Expires < Date.now()) {
					return done(null, false);
				}
				return AuthModel.rawAPI.findById(accesstoken.UserId).then((user) => {
					if (user === null) {
						done(null, false);
					} else {
						done(null, user, accesstoken.Scope);
					}
				}, done);
			} else {
				done(null, false);
			}
		}, err => {
			done(err, false);
		});
	}));
	/* istanbul ignore next */
	server.serializeClient(function (client, done) {
		return done(null, client._id);
	});
	/* istanbul ignore next */
	server.deserializeClient(function (id, done) {
		AuthModel.rawAPI.findById(id, function (err, client) {
			if (err) {
				return done(err);
			}
			return done(null, client);
		});
	});
	/* istanbul ignore next */
	server.grant(oauth2orize.exchange.refreshToken(function (client, refreshToken, scope, done) {
		debug('grant refreshToken');
	}));
	/* istanbul ignore next */
	server.grant(oauth2orize.grant.code(function (client, redirectURI, user, ares) {
		debug(client, redirectURI, user, ares);
	}));
	server.exchange(oauth2orize.exchange.authorizationCode({
		userProperty: 'data'
	}, function (data, accesstoken) {
		return secret(16).then((refreshtoken) => {
			let date = new Date(Date.now() + (configuration.security.tokenTimeout * 1000));
			return models.oauth2accesstokens.create({
				'UserId': data.user._id,
				'RefreshToken': refreshtoken.toString('hex'),
				'Token': accesstoken.toString('hex'),
				'ApplicationId': data.client._id,
				'Expires': date,
				'Scope': 'read write'
			}).then((access) => {
				const response = [
					access.Token, {
						refresh_token: access.RefreshToken,
						expires_in: Math.floor((access.Expires - access.created) / 1000)
					}
				];
				return response;
			});
		});
	}));
	server.exchange(oauth2orize.exchange.password({
		userProperty: 'client'
	}, function (client, username, password) {
		return getUser(username, password).then(user => {
			if (client !== null && user !== null) {
				return secret(16).then((token) => {
					return secret(16).then((refreshtoken) => {
						let date = new Date(Date.now() + (configuration.security.tokenTimeout * 1000));
						return models.oauth2accesstokens.create({
							'UserId': user._id,
							'RefreshToken': refreshtoken.toString('hex'),
							'Token': token.toString('hex'),
							'ApplicationId': client._id,
							'Expires': date,
							'Scope': 'read write'
						}).then((access) => {
							const response = [
								access.Token, {
									refresh_token: access.RefreshToken,
									expires_in: Math.floor((access.Expires - access.created) / 1000)
								}
							];
							return response;
						});
					});
				});
			} else {
				return null;
			}
		});
	}));
	router.post('/singin/', passport.authenticate('local'), async function singin (ctx, next) {
		await next();
		ctx.body = {
			logged: ctx.isAuthenticated()
		};
	});
	const exchanges = {
		'password': 'password',
		'refresh_token': 'refreshToken',
		'code': 'authorization_code'
	};
	const grantType = {
		'password': [2],
		'refresh_token': [3, 2]
	};
	router.post('/token/',
		passport.authenticate(['local', 'bearer', /* 'basic', */ 'oauth2-client-password'], { session: false }),
		async function token (ctx, next) {
			await next();
			ctx.state = {
				data: {
					client: await models.oauth2applications.findOne({
						where: {
							ClientId: ctx.query.client_id
						}
					}),
					user: ctx.req.user
				}
			};
			const type = grantType[ctx.request.body.grant_type];
			switch (ctx.query.response_type) {
				case 'code':
					ctx.request.body.code = (await secret(16)).toString('hex');
					break;
				case 'password':
					ctx.state.client = ctx.state.data.client;
					break;
					/* istanbul ignore next */
				default:
					ctx.response.status = 400;
					return;
			}
			if (!ctx.state.data.user || !ctx.state.data.client) {
				ctx.response.status = 406;
			} /* istanbul ignore next */ else if (type.indexOf(ctx.state.data.client.AuthorizationGrantType) === -1) {
				ctx.response.status = 500;
			} else {
				await server._exchange(exchanges[ctx.query.response_type], ctx, /* istanbul ignore next */ function (err) {
					throw err;
				});
			}
		});
	router.post('/singup/', async function singup (ctx, next) {
		const user = await createUser(ctx.request.body.username, ctx.request.body.password, ctx.request.body);
		if (user !== null && user.id && user.error === undefined) {
			ctx.response.status = 201;
		} else {
			ctx.response.status = 500;
			ctx.body = user;
		}
		await next();
	});
	router.post('/singout', async function singout (ctx, next) {
		ctx.logout();
		await next();
		ctx.status = 200;
	});
	return router.middleware();
}
/**
 * @param {String} model=configuration.security.model - default model is configured at  config/security.js#model
 */
export function setAuthModel (model) {
	AuthModel = models[inflector.pluralize(configuration.security.model)];
}
