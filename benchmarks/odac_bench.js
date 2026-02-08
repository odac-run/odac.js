
global.__dir = __dirname;
process.env.NODE_ENV = 'production';
process.env.PORT = '3000';

const OdacModule = require('../src/Odac.js');

(async () => {
    await OdacModule.init();

    // global.Odac is now available

    // Define routes
    // Plain Text
    global.Odac.Route.get('/', (odac) => {
        return odac.return('Hello World');
    });

    // JSON
    global.Odac.Route.get('/json', (odac) => {
        return odac.return({ hello: 'world' });
    });

    // View
    // Renders benchmarks/view/main/hello.html into {{ MAIN }} of benchmarks/skeleton/bench.html
    global.Odac.Route.page('/view', { skeleton: 'bench', main: 'hello' });

})();
