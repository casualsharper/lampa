// Lampa deep-merges its own defaults into this without overwriting, so these win. Turns off everything that talks to CUB (cub.best and mirrors).
window.lampa_settings = {
    socket_use: false,
    account_use: false,
    account_sync: false,
    plugins_store: false,
    // No extensions: nothing loads plugins, and Settings has no Extensions entry.
    plugins_use: false,
    feed: false,
    services: false,
    geo: false,
    mirrors: false,
    disable_features: {
        dmca: true,
        lgbt: true,
        reactions: true,
        discuss: true,
        ai: true,
        metadata: true,
        subscribe: true,
        blacklist: true,
        persons: true,
        ads: true,
        trailers: true,
        install_proxy: true,
        remote_configuration: true
    }
};

(function () {
    var defaults = {
        // home_config comes from the server (/config.js, set by TORRSERVER), so no address lives in the code.
        torrserver_url: (window.home_config && window.home_config.torrserver) || location.hostname + ':8090',
        torrserver_tracktimecode: 'true',
        parser_use: 'true',
        parser_torrent_type: 'torrserver',
        torrserver_search_type: 'torznab',
        parse_in_search: 'true',
        parse_timeout: '30',
        language: 'en',
        tmdb_lang: 'en',
        interface_size: 'small',
        menu_always: 'true',
        background_type: 'poster',
        player: 'inner',
        // Lampa routes TMDB and posters through CUB's proxy by default.
        proxy_tmdb: 'false',
        proxy_tmdb_auto: 'false',
        proxy_other: 'false'
    };

    // Only fills missing keys, so a client's own changes in Lampa settings survive.
    for (var name in defaults) {
        if (localStorage.getItem(name) === null) localStorage.setItem(name, defaults[name]);
    }
})();
