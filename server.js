const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 55000;
// Sur le Cloud, on configure le mot de passe dans les réglages du site (Variables d'environnement)
// Sinon, par défaut c'est "admin"
const HOST_PASSWORD = process.env.HOST_PASSWORD || "admin";

// --- SETUP SERVEUR ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Permet les connexions de partout
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- ÉTAT GLOBAL (State) ---
const createInitialPlayerState = (id) => ({
    id: id,
    currentVideoId: null,
    playlists: [
        { id: 'default', name: 'Playlist Principale', videos: [] }
    ],
    activePlaylistId: 'default',
    isPlaying: false,
    currentTime: 0,
    lastUpdate: Date.now(),
    isLooping: false,
    isPlaylistLoop: false,
    isShuffle: false,
    playedVideos: []
});

let roomState = {
    1: createInitialPlayerState(1),
    2: createInitialPlayerState(2)
};

// --- GESTION DES UTILISATEURS & SÉCURITÉ ---
let hostId = null;
let connectedUsers = {}; // id -> pseudo

// --- UTILITAIRES ---
function extractVideoID(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        // Gère: youtube.com/watch?v=, youtu.be/, youtube.com/embed/, youtube.com/v/, youtube.com/shorts/
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/ // ID direct
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) return match[1];
        }
        return false;
    } catch (e) { return false; }
}

function broadcastUserList() {
    const list = Object.entries(connectedUsers).map(([id, name]) => ({
        name: name,
        isHost: id === hostId
    }));
    io.emit('updateUserList', list);
}

// --- GESTION SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Connexion:', socket.id);

    // Envoyer l'état complet au nouveau client
    socket.emit('syncState', roomState);
    socket.emit('hostStatus', { hasHost: hostId !== null });

    // Envoyer la liste des utilisateurs directement à ce client (pas broadcast)
    const userList = Object.entries(connectedUsers).map(([id, name]) => ({
        name: name,
        isHost: id === hostId
    }));
    socket.emit('updateUserList', userList);

    // --- CHAT ---
    socket.on('chat:sendMessage', (messageText) => {
        if (!messageText || typeof messageText !== 'string' || !messageText.trim()) return;
        const userPseudo = connectedUsers[socket.id] || 'Anonyme';
        const isSenderHost = (socket.id === hostId);
        io.emit('chat:message', {
            id: Date.now() + Math.random(),
            author: userPseudo,
            text: messageText.trim(),
            isHost: isSenderHost,
            timestamp: Date.now()
        });
    });

    // --- CONNEXION ATOMIQUE ---
    socket.on('loginViewer', (username, callback) => {
        // Vérifier si le pseudo est pris par quelqu'un d'autre (pas par ce socket)
        const existingSocketId = Object.entries(connectedUsers).find(([id, name]) =>
            name.toLowerCase() === username.toLowerCase() && id !== socket.id
        );
        if (existingSocketId) {
            callback({ success: false, message: "Ce pseudo est déjà pris." });
            return;
        }
        connectedUsers[socket.id] = username;
        callback({ success: true });
        broadcastUserList();
        // Envoyer l'état actuel au viewer qui vient de se connecter
        socket.emit('syncState', roomState);
    });

    socket.on('loginHost', ({ username, password }, callback) => {
        // Vérification avec la variable d'environnement ou défaut
        if (password !== HOST_PASSWORD) {
            callback({ success: false, message: "Mot de passe incorrect." });
            return;
        }
        // Si un hôte existe déjà et ce n'est pas une reconnexion du même user
        if (hostId !== null && connectedUsers[hostId] !== username) {
            callback({ success: false, message: "Impossible : Un hôte est déjà présent." });
            return;
        }
        // Vérifier si le pseudo est pris par quelqu'un d'autre
        const existingSocketId = Object.entries(connectedUsers).find(([id, name]) =>
            name.toLowerCase() === username.toLowerCase() && id !== socket.id
        );
        if (existingSocketId) {
            callback({ success: false, message: "Ce pseudo est déjà pris." });
            return;
        }
        connectedUsers[socket.id] = username;
        hostId = socket.id;
        console.log(`HOST Connecté : ${username}`);
        callback({ success: true });
        io.emit('hostStatus', { hasHost: true });
        broadcastUserList();
        // Envoyer l'état actuel au host qui vient de se connecter
        socket.emit('syncState', roomState);
    });

    const onlyHost = (actionCallback) => {
        return (...args) => {
            if (socket.id === hostId) {
                actionCallback(...args);
            }
        };
    };

    // --- ACTIONS PLAYER ---
    socket.on('admin:toggleLoop', onlyHost(({ playerId }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.isLooping = !pState.isLooping;
            io.emit('player:loop', { playerId, isLooping: pState.isLooping });
        }
    }));

    socket.on('admin:togglePlaylistLoop', onlyHost(({ playerId }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaylistLoop = !pState.isPlaylistLoop;
            io.emit('player:playlistLoop', { playerId, isPlaylistLoop: pState.isPlaylistLoop });
        }
    }));

    socket.on('admin:toggleShuffle', onlyHost(({ playerId }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.isShuffle = !pState.isShuffle;
            pState.playedVideos = []; 
            if (pState.currentVideoId) pState.playedVideos.push(pState.currentVideoId);
            io.emit('player:shuffle', { playerId, isShuffle: pState.isShuffle });
        }
    }));

    socket.on('admin:requestNext', onlyHost(({ playerId }) => {
        const pState = roomState[playerId];
        if (!pState) return;
        const playlist = pState.playlists.find(p => p.id === pState.activePlaylistId);
        if (!playlist || !Array.isArray(playlist.videos) || playlist.videos.length === 0) return;

        if (playlist.videos.length === 1) {
            if (pState.isPlaylistLoop) {
                pState.currentTime = 0;
                pState.isPlaying = true;
                pState.lastUpdate = Date.now();
                io.emit('player:play', { playerId, time: 0 });
                return;
            } else { return; }
        }

        let nextVideoId = null;
        if (pState.isShuffle) {
            let candidates = playlist.videos.filter(v => v && v.id && !pState.playedVideos.includes(v.id));
            if (candidates.length === 0) {
                if (pState.isPlaylistLoop) {
                    pState.playedVideos = [];
                    candidates = playlist.videos.filter(v => v && v.id && v.id !== pState.currentVideoId);
                    if (candidates.length === 0) candidates = playlist.videos.filter(v => v && v.id);
                } else { return; }
            }
            if (candidates.length === 0) return;
            const randomIndex = Math.floor(Math.random() * candidates.length);
            nextVideoId = candidates[randomIndex].id;
        } else {
            const currentIndex = playlist.videos.findIndex(v => v && v.id === pState.currentVideoId);
            let nextIndex;
            // Si la vidéo actuelle n'est pas trouvée (-1), commencer à 0
            if (currentIndex === -1) {
                nextIndex = 0;
            } else {
                nextIndex = currentIndex + 1;
            }
            if (nextIndex >= playlist.videos.length) {
                if (pState.isPlaylistLoop) { nextIndex = 0; } else { return; }
            }
            // Vérifier que la vidéo à cet index est valide
            if (!playlist.videos[nextIndex] || !playlist.videos[nextIndex].id) return;
            nextVideoId = playlist.videos[nextIndex].id;
        }

        if (nextVideoId) {
            pState.currentVideoId = nextVideoId;
            pState.currentTime = 0;
            pState.isPlaying = true;
            pState.lastUpdate = Date.now();
            if (pState.isShuffle) pState.playedVideos.push(nextVideoId);
            io.emit('changeVideo', { playerId, videoId: nextVideoId });
            setTimeout(() => { io.emit('player:play', { playerId, time: 0 }); }, 500);
        }
    }));

    socket.on('admin:play', onlyHost(({ playerId, time }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaying = true;
            pState.currentTime = time;
            pState.lastUpdate = Date.now();
            io.emit('player:play', { playerId, time });
        }
    }));

    socket.on('admin:pause', onlyHost(({ playerId, time }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaying = false;
            pState.currentTime = time;
            pState.lastUpdate = Date.now();
            io.emit('player:pause', { playerId, time });
        }
    }));

    socket.on('admin:seek', onlyHost(({ playerId, time }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.currentTime = time;
            pState.lastUpdate = Date.now();
            io.emit('player:seek', { playerId, time });
        }
    }));

    socket.on('admin:selectVideo', onlyHost(({ playerId, videoId }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.currentVideoId = videoId;
            pState.currentTime = 0;
            pState.isPlaying = false;
            if (pState.isShuffle && !pState.playedVideos.includes(videoId)) {
                pState.playedVideos.push(videoId);
            }
            io.emit('changeVideo', { playerId, videoId });
        }
    }));

    socket.on('admin:reorderVideos', onlyHost(({ playerId, playlistId, oldIndex, newIndex }) => {
        const pState = roomState[playerId];
        const pl = pState?.playlists.find(p => p.id === playlistId);
        if (!pl || !Array.isArray(pl.videos)) return;

        // Valider les index
        if (oldIndex < 0 || oldIndex >= pl.videos.length) return;
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= pl.videos.length) newIndex = pl.videos.length - 1;
        if (oldIndex === newIndex) return;

        const item = pl.videos.splice(oldIndex, 1)[0];
        if (!item) return;
        pl.videos.splice(newIndex, 0, item);

        if (pState.isShuffle) {
            pState.isShuffle = false;
            pState.playedVideos = [];
            if (pState.currentVideoId) pState.playedVideos.push(pState.currentVideoId);
            io.emit('player:shuffle', { playerId, isShuffle: false });
        }
        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('admin:reorderPlaylists', onlyHost(({ playerId, oldIndex, newIndex }) => {
        const pState = roomState[playerId];
        if (!pState || !Array.isArray(pState.playlists)) return;

        // Valider les index
        if (oldIndex < 0 || oldIndex >= pState.playlists.length) return;
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= pState.playlists.length) newIndex = pState.playlists.length - 1;
        if (oldIndex === newIndex) return;

        const item = pState.playlists.splice(oldIndex, 1)[0];
        if (!item) return;
        pState.playlists.splice(newIndex, 0, item);
        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('admin:createPlaylist', onlyHost(({ playerId, name }) => {
        const pState = roomState[playerId];
        if (!pState) return;
        const newId = 'pl_' + Date.now();
        pState.playlists.push({ id: newId, name: name || 'Nouvelle Playlist', videos: [] });
        pState.activePlaylistId = newId;
        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('admin:selectPlaylist', onlyHost(({ playerId, id }) => {
        const pState = roomState[playerId];
        if (pState) {
            pState.activePlaylistId = id;
            pState.playedVideos = [];
            io.emit('updateActivePlaylist', { playerId, id });
        }
    }));

    socket.on('admin:renamePlaylist', onlyHost(({ playerId, id, name }) => {
        const pState = roomState[playerId];
        const pl = pState?.playlists.find(p => p.id === id);
        if (pl) {
            pl.name = name;
            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:deletePlaylist', onlyHost(({ playerId, id }) => {
        const pState = roomState[playerId];
        if (!pState || pState.playlists.length <= 1) return;
        const index = pState.playlists.findIndex(p => p.id === id);
        if (index !== -1) {
            pState.playlists.splice(index, 1);
            if (pState.activePlaylistId === id) {
                pState.activePlaylistId = pState.playlists[0].id;
            }
            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:importData', onlyHost(({ playerId, data }) => {
        const pState = roomState[playerId];
        if (!pState || !data || !Array.isArray(data.playlists)) return;

        // Valider et nettoyer les playlists importées
        const validPlaylists = data.playlists
            .filter(pl => pl && typeof pl === 'object' && typeof pl.id === 'string' && typeof pl.name === 'string')
            .map(pl => ({
                id: pl.id,
                name: pl.name,
                videos: Array.isArray(pl.videos)
                    ? pl.videos.filter(v => v && typeof v === 'object' && typeof v.id === 'string')
                        .map(v => ({ id: v.id, url: v.url || '', title: v.title || 'Sans titre' }))
                    : []
            }));

        // Si aucune playlist valide, créer une playlist par défaut
        if (validPlaylists.length === 0) {
            validPlaylists.push({ id: 'default', name: 'Playlist Principale', videos: [] });
        }

        pState.playlists = validPlaylists;
        pState.activePlaylistId = validPlaylists[0].id;
        pState.isPlaylistLoop = !!data.isPlaylistLoop;
        pState.isShuffle = !!data.isShuffle;
        pState.playedVideos = [];

        // Réinitialiser la vidéo en cours si elle n'existe plus dans les playlists
        const allVideoIds = validPlaylists.flatMap(pl => pl.videos.map(v => v.id));
        if (pState.currentVideoId && !allVideoIds.includes(pState.currentVideoId)) {
            pState.currentVideoId = null;
            pState.isPlaying = false;
            io.emit('changeVideo', { playerId, videoId: null });
        }

        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        io.emit('player:playlistLoop', { playerId, isPlaylistLoop: pState.isPlaylistLoop });
        io.emit('player:shuffle', { playerId, isShuffle: pState.isShuffle });
    }));

    socket.on('admin:addVideo', onlyHost(({ playerId, url, playlistId }) => {
        const pState = roomState[playerId];
        if (!pState) return;
        const videoId = extractVideoID(url);
        if (videoId) {
            const targetPlaylist = playlistId 
                ? pState.playlists.find(p => p.id === playlistId)
                : pState.playlists.find(p => p.id === pState.activePlaylistId);

            if (targetPlaylist) {
                targetPlaylist.videos.push({ 
                    id: videoId, 
                    url: url, 
                    title: `Vidéo ${targetPlaylist.videos.length + 1}` 
                });
                if (!pState.currentVideoId) {
                    pState.currentVideoId = videoId;
                    pState.playedVideos.push(videoId); 
                    io.emit('changeVideo', { playerId, videoId });
                }
                io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
            }
        }
    }));

    socket.on('admin:renameVideo', onlyHost(({ playerId, playlistId, videoIndex, newName }) => {
        const pState = roomState[playerId];
        const pl = pState?.playlists.find(p => p.id === playlistId);
        if (pl && pl.videos[videoIndex]) {
            pl.videos[videoIndex].title = newName;
            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:removeVideo', onlyHost(({ playerId, playlistId, index }) => {
        const pState = roomState[playerId];
        const pl = pState?.playlists.find(p => p.id === playlistId);
        if (!pl || !Array.isArray(pl.videos) || index < 0 || index >= pl.videos.length) return;

        // Sauvegarder l'ID de la vidéo qu'on va supprimer
        const removedVideoId = pl.videos[index]?.id;
        pl.videos.splice(index, 1);

        // Si la vidéo supprimée était en cours de lecture
        if (removedVideoId && pState.currentVideoId === removedVideoId) {
            // Retirer de l'historique de lecture shuffle
            pState.playedVideos = pState.playedVideos.filter(id => id !== removedVideoId);

            // Si la playlist active est celle où on a supprimé
            if (playlistId === pState.activePlaylistId) {
                if (pl.videos.length > 0) {
                    // Jouer la vidéo suivante (ou la première si on était à la fin)
                    const nextIndex = Math.min(index, pl.videos.length - 1);
                    pState.currentVideoId = pl.videos[nextIndex].id;
                    pState.currentTime = 0;
                    pState.isPlaying = false;
                    io.emit('changeVideo', { playerId, videoId: pState.currentVideoId });
                } else {
                    // Playlist vide, réinitialiser
                    pState.currentVideoId = null;
                    pState.isPlaying = false;
                    io.emit('changeVideo', { playerId, videoId: null });
                }
            }
        }

        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            broadcastUserList();
        }
        if (socket.id === hostId) {
            hostId = null;
            io.emit('hostStatus', { hasHost: false });
            broadcastUserList();
        }
    });
});

// --- LANCEMENT PRODUCTION ---
server.listen(PORT, () => {
    console.log(`\n--- AKUWATCH LANCÉ SUR LE PORT ${PORT} ---`);
});