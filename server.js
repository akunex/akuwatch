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
        // Support: youtube.com/watch, youtu.be/, youtube.com/embed/, youtube.com/v/, youtube.com/shorts/
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/ // ID direct
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1] && match[1].length === 11) {
                return match[1];
            }
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
    const MAX_MESSAGE_LENGTH = 1000;
    socket.on('chat:sendMessage', (messageText) => {
        if (!messageText || typeof messageText !== 'string' || !messageText.trim()) return;
        // Limiter la longueur du message pour éviter les abus
        const sanitizedMessage = messageText.trim().substring(0, MAX_MESSAGE_LENGTH);
        const userPseudo = connectedUsers[socket.id] || 'Anonyme';
        const isSenderHost = (socket.id === hostId);
        io.emit('chat:message', {
            id: Date.now() + Math.random(),
            author: userPseudo,
            text: sanitizedMessage,
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

    // --- UTILITAIRES VALIDATION ---
    const isValidPlayerId = (pid) => pid === 1 || pid === 2;

    // --- ACTIONS PLAYER ---
    socket.on('admin:toggleLoop', onlyHost(({ playerId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.isLooping = !pState.isLooping;
            io.emit('player:loop', { playerId, isLooping: pState.isLooping });
        }
    }));

    socket.on('admin:togglePlaylistLoop', onlyHost(({ playerId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaylistLoop = !pState.isPlaylistLoop;
            io.emit('player:playlistLoop', { playerId, isPlaylistLoop: pState.isPlaylistLoop });
        }
    }));

    socket.on('admin:toggleShuffle', onlyHost(({ playerId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.isShuffle = !pState.isShuffle;
            pState.playedVideos = [];
            if (pState.currentVideoId) pState.playedVideos.push(pState.currentVideoId);
            io.emit('player:shuffle', { playerId, isShuffle: pState.isShuffle });
        }
    }));

    socket.on('admin:requestNext', onlyHost(({ playerId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState) return;
        const playlist = pState.playlists.find(p => p.id === pState.activePlaylistId);
        if (!playlist || playlist.videos.length === 0) return;

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
            let candidates = playlist.videos.filter(v => !pState.playedVideos.includes(v.id));
            if (candidates.length === 0) {
                if (pState.isPlaylistLoop) {
                    pState.playedVideos = [];
                    candidates = playlist.videos.filter(v => v.id !== pState.currentVideoId);
                    if (candidates.length === 0) candidates = playlist.videos;
                } else { return; }
            }
            const randomIndex = Math.floor(Math.random() * candidates.length);
            nextVideoId = candidates[randomIndex].id;
        } else {
            const currentIndex = playlist.videos.findIndex(v => v.id === pState.currentVideoId);
            let nextIndex = currentIndex + 1;
            if (nextIndex >= playlist.videos.length) {
                if (pState.isPlaylistLoop) { nextIndex = 0; } else { return; }
            }
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
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaying = true;
            pState.currentTime = typeof time === 'number' && !isNaN(time) && time >= 0 ? time : 0;
            pState.lastUpdate = Date.now();
            io.emit('player:play', { playerId, time: pState.currentTime });
        }
    }));

    socket.on('admin:pause', onlyHost(({ playerId, time }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.isPlaying = false;
            pState.currentTime = typeof time === 'number' && !isNaN(time) && time >= 0 ? time : 0;
            pState.lastUpdate = Date.now();
            io.emit('player:pause', { playerId, time: pState.currentTime });
        }
    }));

    socket.on('admin:seek', onlyHost(({ playerId, time }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState) {
            pState.currentTime = typeof time === 'number' && !isNaN(time) && time >= 0 ? time : 0;
            pState.lastUpdate = Date.now();
            io.emit('player:seek', { playerId, time: pState.currentTime });
        }
    }));

    socket.on('admin:selectVideo', onlyHost(({ playerId, videoId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (pState && videoId && typeof videoId === 'string') {
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
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState) return;
        const pl = pState.playlists.find(p => p.id === playlistId);
        if (!pl || oldIndex < 0 || oldIndex >= pl.videos.length || newIndex < 0 || newIndex >= pl.videos.length) return;
        if (oldIndex === newIndex) return;

        const item = pl.videos.splice(oldIndex, 1)[0];
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
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || oldIndex < 0 || oldIndex >= pState.playlists.length || newIndex < 0 || newIndex >= pState.playlists.length) return;
        if (oldIndex === newIndex) return;

        const item = pState.playlists.splice(oldIndex, 1)[0];
        pState.playlists.splice(newIndex, 0, item);
        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('admin:createPlaylist', onlyHost(({ playerId, name }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState) return;
        const sanitizedName = (typeof name === 'string' && name.trim()) ? name.trim().substring(0, 100) : 'Nouvelle Playlist';
        const newId = 'pl_' + Date.now();
        pState.playlists.push({ id: newId, name: sanitizedName, videos: [] });
        pState.activePlaylistId = newId;
        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
    }));

    socket.on('admin:selectPlaylist', onlyHost(({ playerId, id }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !id || typeof id !== 'string') return;
        // Vérifier que la playlist existe
        const playlistExists = pState.playlists.some(p => p.id === id);
        if (!playlistExists) return;
        pState.activePlaylistId = id;
        pState.playedVideos = [];
        io.emit('updateActivePlaylist', { playerId, id });
    }));

    socket.on('admin:renamePlaylist', onlyHost(({ playerId, id, name }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !id || !name || typeof name !== 'string') return;
        const pl = pState.playlists.find(p => p.id === id);
        if (pl) {
            pl.name = name.trim().substring(0, 100) || pl.name;
            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:deletePlaylist', onlyHost(({ playerId, id }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !id || typeof id !== 'string' || pState.playlists.length <= 1) return;
        const index = pState.playlists.findIndex(p => p.id === id);
        if (index !== -1) {
            const deletedPlaylist = pState.playlists[index];
            const wasActive = pState.activePlaylistId === id;

            pState.playlists.splice(index, 1);

            if (wasActive) {
                pState.activePlaylistId = pState.playlists[0].id;

                // Vérifier si currentVideoId était dans la playlist supprimée
                const videoWasInDeleted = deletedPlaylist.videos.some(v => v.id === pState.currentVideoId);
                if (videoWasInDeleted) {
                    // Réinitialiser à la première vidéo de la nouvelle playlist active (ou null)
                    const newActivePlaylist = pState.playlists.find(p => p.id === pState.activePlaylistId);
                    if (newActivePlaylist && newActivePlaylist.videos.length > 0) {
                        pState.currentVideoId = newActivePlaylist.videos[0].id;
                        pState.currentTime = 0;
                        pState.isPlaying = false;
                        io.emit('changeVideo', { playerId, videoId: pState.currentVideoId });
                    } else {
                        pState.currentVideoId = null;
                        pState.currentTime = 0;
                        pState.isPlaying = false;
                        io.emit('changeVideo', { playerId, videoId: null });
                    }
                }
            }

            // Nettoyer playedVideos des vidéos de la playlist supprimée
            const deletedVideoIds = deletedPlaylist.videos.map(v => v.id);
            pState.playedVideos = pState.playedVideos.filter(id => !deletedVideoIds.includes(id));

            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:importData', onlyHost(({ playerId, data }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !data || !Array.isArray(data.playlists) || data.playlists.length === 0) return;

        // Valider et nettoyer les playlists importées
        const validPlaylists = data.playlists
            .filter(pl => pl && typeof pl.id === 'string' && typeof pl.name === 'string' && Array.isArray(pl.videos))
            .map(pl => ({
                id: pl.id,
                name: pl.name.substring(0, 100), // Limiter la longueur du nom
                videos: pl.videos
                    .filter(v => v && typeof v.id === 'string' && v.id.length === 11)
                    .map(v => ({
                        id: v.id,
                        url: typeof v.url === 'string' ? v.url : `https://youtube.com/watch?v=${v.id}`,
                        title: typeof v.title === 'string' ? v.title.substring(0, 200) : 'Vidéo importée'
                    }))
            }));

        if (validPlaylists.length === 0) return;

        pState.playlists = validPlaylists;
        pState.activePlaylistId = validPlaylists[0].id;
        pState.isPlaylistLoop = !!data.isPlaylistLoop;
        pState.isShuffle = !!data.isShuffle;
        pState.playedVideos = [];

        // Réinitialiser la vidéo en cours
        if (validPlaylists[0].videos.length > 0) {
            pState.currentVideoId = validPlaylists[0].videos[0].id;
        } else {
            pState.currentVideoId = null;
        }
        pState.currentTime = 0;
        pState.isPlaying = false;

        io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        io.emit('player:playlistLoop', { playerId, isPlaylistLoop: pState.isPlaylistLoop });
        io.emit('player:shuffle', { playerId, isShuffle: pState.isShuffle });
        io.emit('changeVideo', { playerId, videoId: pState.currentVideoId });
    }));

    socket.on('admin:addVideo', onlyHost(({ playerId, url, playlistId }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !url || typeof url !== 'string') return;
        const videoId = extractVideoID(url);
        if (videoId) {
            const targetPlaylist = playlistId
                ? pState.playlists.find(p => p.id === playlistId)
                : pState.playlists.find(p => p.id === pState.activePlaylistId);

            if (targetPlaylist) {
                // Vérifier si la vidéo n'est pas déjà dans la playlist (éviter doublons)
                const alreadyExists = targetPlaylist.videos.some(v => v.id === videoId);
                if (alreadyExists) return; // Silently ignore duplicates

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
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !playlistId || typeof newName !== 'string') return;
        const pl = pState.playlists.find(p => p.id === playlistId);
        if (pl && videoIndex >= 0 && videoIndex < pl.videos.length) {
            pl.videos[videoIndex].title = newName.trim().substring(0, 200) || pl.videos[videoIndex].title;
            io.emit('updatePlaylists', { playerId, playlists: pState.playlists, activeId: pState.activePlaylistId });
        }
    }));

    socket.on('admin:removeVideo', onlyHost(({ playerId, playlistId, index }) => {
        if (!isValidPlayerId(playerId)) return;
        const pState = roomState[playerId];
        if (!pState || !playlistId || typeof index !== 'number') return;
        const pl = pState.playlists.find(p => p.id === playlistId);
        if (!pl || index < 0 || index >= pl.videos.length) return;

        const removedVideo = pl.videos[index];
        pl.videos.splice(index, 1);

        // Si la vidéo supprimée était en cours de lecture, réinitialiser ou passer à une autre
        if (pState.currentVideoId === removedVideo.id) {
            if (pl.videos.length > 0) {
                // Passer à la vidéo suivante (ou première si on était à la fin)
                const newIndex = Math.min(index, pl.videos.length - 1);
                pState.currentVideoId = pl.videos[newIndex].id;
                pState.currentTime = 0;
                pState.isPlaying = false;
                io.emit('changeVideo', { playerId, videoId: pState.currentVideoId });
            } else {
                // Playlist vide
                pState.currentVideoId = null;
                pState.currentTime = 0;
                pState.isPlaying = false;
                io.emit('changeVideo', { playerId, videoId: null });
            }
        }

        // Nettoyer playedVideos si nécessaire
        pState.playedVideos = pState.playedVideos.filter(id => id !== removedVideo.id);

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