"use strict";
//https://github.com/alexmingoia/koa-router
let Router = require(process.cwd() + '/node_modules/koa-router');
let fs = require('fs');
module.exports = function (app) {
	let router = Router();
	let controllersDir = process.cwd() + "/controllers/";
	fs.readdirSync(controllersDir).forEach(function (file) {
		file = file.replace(".js", "");
		let controller = require(controllersDir + file);
		controller.Name = controller.Name || file;
		if (controller.REST !== false) {
			if (controller.Pluralize !== false) {
				controller.Name = app.inflect.pluralize(controller.Name);
			}
			app.use(function* (next) {
				this.model = this.db[controller.Name];
				yield next;
			});
			router.get(`/${controller.Name}/`, function* (next) {
					this.body = yield this.model.find();
					yield next;
				}).get(`/${controller.Name}/:id`, function* (next) {
					this.body = yield this.model.findOne({
						id: this.params.id
					});
					yield next;
				}).post(`/${controller.Name}/`, function* (next) {
					yield next;
				})
				.put(`/${controller.Name}/:id`, function* (next) {
					yield next;
				})
				.del(`/${controller.Name}/:id`, function* (next) {
					yield this.model.destroy({
						id: this.params.id
					});
					this.body = {
						id: this.params.id
					};
					yield next;
				});
		} else {

		}
	});
	router.get("/", function* (next) {
		yield this.render("index", {
			title: 'cool'
		});
	});
	return router.middleware();
};