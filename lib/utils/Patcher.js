var path = require('path');
var fs = require('fs');
var url = require('url');

var glob = require('glob');
var et = require('elementtree');
var cheerio = require('cheerio');
var Policy = require('csp-parse');
var plist = require('plist');

var WWW_FOLDER = {
    android: 'app/src/main/assets/www',
    ios: 'www',
    browser:'www',
    windows:'www',
    electron:'www',
};

var CONFIG_LOCATION = {
    android: 'app/src/main/res/xml',
    ios: '.',
    browser:'.',
    windows:'.',
    electron:'.',
};

var START_PAGE = 'browser-sync-start.html';

function parseXml(filename) {
    return new et.ElementTree(et.XML(fs.readFileSync(filename, "utf-8").replace(/^\uFEFF/, "")));
}

function Patcher(projectRoot, platforms) {
    this.projectRoot = projectRoot || '.';
    if (typeof platforms === 'string') {
        platforms = platforms.split(',');
    }
    this.platforms = platforms || ['android', 'ios', 'windows', 'electron'];
}

Patcher.PLATORM_DISABLE = 'platformDisable';

Patcher.prototype.on = function(type, callback) {
    if(!this.__listeners) {
        this.__listeners = {};
    }

    if(!this.__listeners[type]) {
        this.__listeners[type] = [];
    }

    this.__listeners[type].push(callback);
};

Patcher.prototype.__emit = function(type, data) {
    if(!this.__listeners) {
        return;
    }

    if(!this.__listeners[type]) {
        return;
    }

    const listeners = this.__listeners[type];

    for(const callback of listeners) {
        callback(data);
    }
};

Patcher.prototype.__forEachFile = function(pattern, location, fn) {
    this.platforms.forEach(function(platform) {
        glob.sync(pattern, {
            cwd: path.join(this.projectRoot, 'platforms', platform, location[platform]),
            ignore: '*build/**'
        }).forEach(function(filename) {
            filename = path.join(this.projectRoot, 'platforms', platform, location[platform], filename);
            fn.apply(this, [filename, platform]);
        }, this);
    }, this);
};

Patcher.prototype.addCSP = function(opts) {
    this.__forEachFile('**/index.html', WWW_FOLDER, function(filename, platform) {
        var pageContent = fs.readFileSync(filename, 'utf-8');
        var $ = cheerio.load(pageContent, {
            decodeEntities: false
        });
        var cspTag = $('meta[http-equiv=Content-Security-Policy]');
        var policy = new Policy(cspTag.attr('content'));
        policy.add('default-src', 'ws:');
        policy.add('default-src', "'unsafe-inline'");
        policy.add('script-src', "'self'");
        policy.add('script-src', "'unsafe-inline'");
        for (var key in opts.servers)
        {
            if (typeof opts.servers[key] !== 'undefined')
            {
                policy.add('script-src', opts.servers[key]);
            }
        }
        cspTag.attr('content', function() {
            return policy.toString();
        });
        fs.writeFileSync(filename, $.html());
        //console.log('Added CSP for ', filename);
    });
};

Patcher.prototype.copyStartPage = function(opts) {
    var html = fs.readFileSync(path.join(__dirname, START_PAGE), 'utf-8');
    this.__forEachFile('**/index.html', WWW_FOLDER, function(filename, platform) {
        var dest = path.join(path.dirname(filename), START_PAGE);
        var data = {};
        for (var key in opts.servers)
        {
            if (typeof opts.servers[key] !== 'undefined')
            {
                data[key] = url.resolve(opts.servers[key], platform + '/www/' + opts.index);
            }
        }

        var resultHTML = html
            .replace(/__SERVERS__/, JSON.stringify(data))
            .replace(/__FORCE_LOAD__/, opts.forceLoad)
            .replace(/__USE_IFRAME__/, String(platform === 'windows'));

        fs.writeFileSync(dest, resultHTML);
    });
};

Patcher.prototype.updateConfigXml = function() {
    return this.__forEachFile('**/config.xml', CONFIG_LOCATION, function(filename, platform) {
        var configXml = parseXml(filename);
        var contentTag = configXml.find('content[@src]');
        if (contentTag) {
            contentTag.attrib.src = START_PAGE;
        }
        // Also add allow nav in case of
        var allowNavTag = et.SubElement(configXml.find('.'), 'allow-navigation');
        allowNavTag.set('href', '*');
        fs.writeFileSync(filename, configXml.write({
            indent: 4
        }), "utf-8");
        //console.log('Set start page for %s', filename);
    });
};

Patcher.prototype.updateManifestJSON = function() {
    return this.__forEachFile('**/manifest.json', CONFIG_LOCATION, function(filename, platform) {
        var manifest = require(filename);
        manifest.start_url = START_PAGE;
        fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), "utf-8");
        // console.log('Set start page for %s', filename)
    });
};

Patcher.prototype.fixATS = function() {
    return this.__forEachFile('**/*Info.plist', CONFIG_LOCATION, function(filename) {
        try {
            var data = plist.parse(fs.readFileSync(filename, 'utf-8'));
            data.NSAppTransportSecurity = {
                NSAllowsArbitraryLoads: true
            };
            fs.writeFileSync(filename, plist.build(data));
            //console.log('Fixed ATS in ', filename);
        } catch (err) {
            console.log('Error when parsing', filename, err);
        }
    });
};

Patcher.prototype.updateAppxManifest = function() {
    return this.__forEachFile('**/*.appxmanifest', CONFIG_LOCATION, function(filename, platform) {
        if(platform === 'windows') {
            var manifectXML = parseXml(filename);
            var contentTag = manifectXML.find('*/Application[@StartPage]');
            if (contentTag) {
                contentTag.attrib.StartPage = contentTag.attrib.StartPage.replace('index.html', START_PAGE);
            }
            fs.writeFileSync(filename, manifectXML.write({
                indent: 4
            }), "utf-8");
        }
    });
};

Patcher.prototype.updateElectronMainJS = function () {
    return this.__forEachFile('**/cdv-electron-main.js', CONFIG_LOCATION, function(filename, platform) {
        if(!filename.includes('platform_www')) {
            var code = fs.readFileSync(filename).toString();

            var sourceLine = 'mainWindow.loadURL(`file://${__dirname}/index.html`);';
            var targetLine = 'mainWindow.loadURL(`file://${__dirname}/' + START_PAGE +'`);';

            if(code.includes(sourceLine)) {
                code = code.replace(sourceLine, targetLine);
                fs.writeFileSync(filename, code);
            }

            this.__emit(Patcher.PLATORM_DISABLE, 'electron');
        }
    });
};

Patcher.prototype.prepatch = function() {
    // copy the serverless start page so initial load doesn't throw 404
    this.copyStartPage({});
    this.updateConfigXml();
    this.updateManifestJSON();
    this.updateAppxManifest();
};

Patcher.prototype.patch = function(opts) {
    opts = opts || {};
    this.copyStartPage(opts);
    this.fixATS();
    this.addCSP(opts);
    this.updateElectronMainJS();
};

Patcher.prototype.getWWWFolder = function(platform)
{
    return path.join('platforms', platform, WWW_FOLDER[platform]);
};

module.exports = Patcher;
