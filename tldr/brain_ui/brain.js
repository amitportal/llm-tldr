/**
 * TLDR Brain v2 - Enhanced Visualization
 * Three view modes + cluster spheres + similarity heatmap + edge highlighting
 */

const Graph = ForceGraph3D()
    (document.getElementById('3d-graph'));

let graphData = { nodes: [], links: [], clusters: [], similarity_pairs: [] };
let currentView = 'force';
let hybridBlend = 0.5;
let isDarkTheme = true;
let showClusterSpheres = false;
let clusterSphereMeshes = [];
let selectedNode = null;
let comparisonPanel = null;

// Phase 6: Neighbor label sprites
let neighborLabelSprites = [];

// Phase 8: Cluster label sprites
let showClusterLabels = false;
let clusterLabelSprites = [];

// Centrality weight sliders
let weights = { pagerank: 0.6, influence: 0.2, support: 0.2 };

const LAYER_COLORS = {
    'ENTRY': '#00ff88',
    'MIDDLE': '#00aaff',
    'LEAF': '#ff8800',
    'FILE': '#ffffff',
    'UNKNOWN': '#888888'
};

const CLUSTER_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
    '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4',
    '#469990', '#dcbeff', '#9A6324', '#fffac8', '#800000',
    '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9'
];

// Info descriptions
const INFO_TEXTS = {
    'toggle-theme': 'Switch between dark and light color themes',
    'zoom-fit': 'Reset camera to show all nodes in view',
    'cluster-spheres': 'Show translucent spheres around semantic clusters (works in Semantic/Hybrid views)',
    'similarity-map': 'Show a panel of most similar code pairs based on semantic embeddings',
    'blend-control': 'Adjust balance between structural (force) and semantic (embedding) positioning',
    'centrality-filter': 'Hide nodes below this PageRank centrality threshold',
    'weight-pagerank': 'Weight of global PageRank importance in node sizing',
    'weight-influence': 'Weight of incoming neighbor importance (nodes that call this function)',
    'weight-support': 'Weight of outgoing neighbor importance (nodes this function calls)',
    'legend': 'Entry Points: CLI/API entry functions | Workflow: Business logic | Leaves: Utilities'
};

async function init() {
    try {
        const res = await fetch('/api/brain');
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();

        console.log(`Loaded: ${data.nodes?.length} nodes, ${data.edges?.length} edges, ${data.clusters?.length} clusters`);

        graphData = {
            nodes: data.nodes || [],
            links: data.edges || [],
            clusters: data.clusters || [],
            similarity_pairs: data.similarity_pairs || []
        };

        graphData.nodes.forEach(node => {
            node.force_x = null;
            node.force_y = null;
            node.force_z = null;
        });

        setupGraph();
        renderHeatmap();
        setupInfoButtons();

        // Phase 1: Initialize centrality filter to match HTML default (0.5%)
        filterByCentrality(0.005);

        setTimeout(() => {
            graphData.nodes.forEach(node => {
                node.force_x = node.x;
                node.force_y = node.y;
                node.force_z = node.z;
            });
        }, 5000);

    } catch (err) {
        console.error("Init error:", err);
        alert("Error loading graph: " + err.message);
    }
}

function setupGraph() {
    Graph
        .graphData(graphData)
        .nodeId('id')
        .nodeLabel(node => `${node.label}\n[${node.layer}] Cluster: ${node.cluster_id ?? 'none'}`)
        .nodeColor(node => {
            if (node.cluster_id !== undefined && node.cluster_id >= 0) {
                return CLUSTER_COLORS[node.cluster_id % CLUSTER_COLORS.length];
            }
            return LAYER_COLORS[node.layer] || '#888888';
        })
        .nodeVal(node => Math.max(3, computeCustomScore(node) * 300))
        .nodeOpacity(0.9)
        .linkSource('source')
        .linkTarget('target')
        .linkColor(link => getLinkColor(link))
        .linkWidth(link => link.type === 'call' ? 0.5 : 0.3)  // Thinner edges so particles show
        .linkOpacity(0.15)  // Very transparent edges
        .linkDirectionalArrowLength(link => link.type === 'call' ? 2 : 0)
        .linkDirectionalArrowRelPos(1)
        // Phase 2: Particles for call AND import edges (heartbeat preserved)
        .linkDirectionalParticles(link => {
            if (link.type === 'call') return 5;    // Many particles
            if (link.type === 'import') return 10;  // Fewer particles
            return 0;  // No particles for 'contains'
        })
        .linkDirectionalParticleSpeed(link => {
            if (link.type === 'call') return 0.004;   // Fast
            if (link.type === 'import') return 0.002; // Slower
            return 0;
        })
        .linkDirectionalParticleWidth(2)  // Larger than edge width!
        .linkDirectionalParticleColor(link => getParticleColor(link))  // Dynamic color
        .backgroundColor(isDarkTheme ? '#0a0a1a' : '#f0f0f0')
        .linkThreeObjectExtend(true)
        .linkThreeObject(link => {
            if (!link.label && !link.snippet) return null;
            if (!window.THREE) return null;

            // Simple text sprite for label
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 256;
            canvas.height = 64;
            ctx.fillStyle = isDarkTheme ? '#ffffff' : '#000000';
            ctx.font = 'bold 32px Sans-Serif';
            ctx.textAlign = 'center';
            ctx.fillText(link.label || link.type, 128, 40);

            const texture = new window.THREE.CanvasTexture(canvas);
            const material = new window.THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.8 });
            const sprite = new window.THREE.Sprite(material);
            sprite.scale.set(10, 2.5, 1);
            sprite.visible = false; // Hidden by default

            // Store specific data on sprite for updates
            sprite.userData = { isLabel: true, link: link };
            return sprite;
        })
        .linkPositionUpdate((sprite, { start, end }) => {
            if (!sprite) return false;
            const middlePos = Object.assign(...['x', 'y', 'z'].map(c => ({
                [c]: start[c] + (end[c] - start[c]) / 2
            })));
            Object.assign(sprite.position, middlePos);
            return true;
        })
        .onNodeClick(node => {
            selectedNode = node;
            showDetails(node);
            updateLinkHighlighting();
            // Phase 3: Smart zoom to show node + neighbors
            zoomToNodeContext(node);
        })
        .onLinkClick(link => {
            if (link.snippet) {
                showInfoModal(`Edge: ${link.source.label || link.source} -> ${link.target.label || link.target}\nType: ${link.type}\n\n${link.snippet}`);
            }
        })
        .onBackgroundClick(() => {
            selectedNode = null;
            updateLinkHighlighting();
        });

    setTimeout(() => Graph.zoomToFit(500, 50), 3000);
}

function getLinkColor(link) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

    if (selectedNode) {
        // Connected edges get colored tint (still transparent for particles)
        if (srcId === selectedNode.id) {
            return 'rgba(0, 191, 255, 0.7)';  // DeepSkyBlue tint - outgoing (Bright & Visible)
        } else if (tgtId === selectedNode.id) {
            return 'rgba(245, 6, 6, 0.5)';  // Bright Red tint - incoming
        }
        // Non-connected edges fade to nearly invisible
        return isDarkTheme ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
    }

    // Default: green edges
    if (link.type === 'call') return isDarkTheme ? 'rgba(0,255,136,0.15)' : 'rgba(0,100,50,0.15)';
    if (link.type === 'contains') return isDarkTheme ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    if (link.type === 'import') return isDarkTheme ? 'rgba(255, 215, 0, 0.15)' : 'rgba(180, 140, 0, 0.15)'; // Gold
    return isDarkTheme ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
}

function getParticleColor(link) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

    if (selectedNode) {
        if (srcId === selectedNode.id) return '#00bfffff';  // DeepSkyBlue - outgoing
        if (tgtId === selectedNode.id) return '#ff0000ff';  // Bright Red - incoming
        return 'rgba(0,255,136,0.1)';  // Very faded for unconnected
    }

    // Phase 2: Default colors by edge type
    if (link.type === 'call') return '#00ff88aa';    // Bright green
    if (link.type === 'import') return '#ffd700aa';  // Gold
    return '#00ff88aa';
}

// Phase 5: Smart camera positioning - clicked node on left, neighbors on right
function zoomToNodeContext(node) {
    // Get neighbor node objects
    const neighbors = [];
    graphData.links.forEach(link => {
        const src = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source);
        const tgt = typeof link.target === 'object' ? link.target : graphData.nodes.find(n => n.id === link.target);
        if (src?.id === node.id && tgt) neighbors.push(tgt);
        if (tgt?.id === node.id && src) neighbors.push(src);
    });

    if (neighbors.length === 0) {
        // No neighbors - just center on node with moderate zoom
        Graph.cameraPosition(
            { x: node.x - 150, y: node.y, z: node.z + 100 },
            { x: node.x, y: node.y, z: node.z },
            500
        );
        return;
    }

    // Calculate centroid of node + neighbors
    const allNodes = [node, ...neighbors];
    const cx = allNodes.reduce((sum, n) => sum + (n.x || 0), 0) / allNodes.length;
    const cy = allNodes.reduce((sum, n) => sum + (n.y || 0), 0) / allNodes.length;
    const cz = allNodes.reduce((sum, n) => sum + (n.z || 0), 0) / allNodes.length;

    // Calculate max distance for zoom level
    const maxDist = Math.max(...allNodes.map(n =>
        Math.sqrt((n.x - cx) ** 2 + (n.y - cy) ** 2 + (n.z - cz) ** 2)
    ), 50);

    // Position camera: selected node on left, looking at centroid
    const cameraDistance = maxDist * 2.5 + 80;
    Graph.cameraPosition(
        { x: node.x - cameraDistance * 0.8, y: cy, z: cz + cameraDistance * 0.5 },
        { x: cx, y: cy, z: cz },
        500
    );
}

// Phase 6: Create floating label for a neighbor node
function createNeighborLabel(node, connectionType) {
    if (!window.THREE) return null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 512;
    canvas.height = 128;

    // Background with rounded corners
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 512, 128, 12);
    ctx.fill();

    // Node name (large, white)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    const label = node.label || node.id.split('::').pop();
    ctx.fillText(label.length > 25 ? label.slice(0, 22) + '...' : label, 256, 50);

    // Connection type (smaller, colored based on direction)
    ctx.fillStyle = connectionType.includes('←') ? '#ff6666' : '#66aaff';
    ctx.font = '22px Arial';
    ctx.fillText(connectionType, 256, 95);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false  // Always visible
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(node.x || 0, (node.y || 0) + 12, node.z || 0);
    sprite.scale.set(28, 7, 1);

    return sprite;
}

// Phase 6: Update neighbor labels when selection changes
function updateNeighborLabels() {
    const scene = Graph.scene();
    if (!scene) return;

    // Clear existing labels
    neighborLabelSprites.forEach(sprite => scene.remove(sprite));
    neighborLabelSprites = [];

    if (!selectedNode || !window.THREE) return;

    // Track which neighbors we've already labeled (avoid duplicates)
    const labeled = new Set();

    // Find neighbors and their connection types
    graphData.links.forEach(link => {
        const src = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source);
        const tgt = typeof link.target === 'object' ? link.target : graphData.nodes.find(n => n.id === link.target);

        let neighborNode = null;
        let connectionLabel = '';

        if (src?.id === selectedNode.id && tgt && !labeled.has(tgt.id)) {
            neighborNode = tgt;
            connectionLabel = link.type === 'call' ? '→ calls' :
                link.type === 'import' ? '→ imports' :
                    link.type === 'contains' ? '⊃ contains' : '→';
            labeled.add(tgt.id);
        } else if (tgt?.id === selectedNode.id && src && !labeled.has(src.id)) {
            neighborNode = src;
            connectionLabel = link.type === 'call' ? '← called by' :
                link.type === 'import' ? '← imported by' :
                    link.type === 'contains' ? '⊂ in' : '←';
            labeled.add(src.id);
        }

        if (neighborNode) {
            const sprite = createNeighborLabel(neighborNode, connectionLabel);
            if (sprite) {
                scene.add(sprite);
                neighborLabelSprites.push(sprite);
            }
        }
    });
}


function updateLinkHighlighting() {
    Graph
        .linkColor(link => getLinkColor(link))
        .linkDirectionalParticleColor(link => getParticleColor(link));

    // Update label visibility
    const scene = Graph.scene();
    scene.traverse(obj => {
        if (obj.userData && obj.userData.isLabel) {
            const link = obj.userData.link;
            const srcId = typeof link.source === 'object' ? link.source.id : link.source;
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

            let visible = false;

            if (selectedNode) {
                if (srcId === selectedNode.id || tgtId === selectedNode.id) {
                    visible = true;
                }
            }

            obj.visible = visible;
        }
    });

    // Phase 4: Refresh visibility to show/hide neighbors based on selection
    filterByCentrality(currentCentralityThreshold);

    // Phase 6: Update neighbor labels
    updateNeighborLabels();
}


function computeCustomScore(node) {
    const pr = node.centrality || 0;
    const inf = node.neighbor_influence || 0;
    const sup = node.neighbor_support || 0;
    return pr * weights.pagerank + inf * weights.influence + sup * weights.support;
}

function updateWeights() {
    weights.pagerank = parseFloat(document.getElementById('weight-pagerank').value);
    weights.influence = parseFloat(document.getElementById('weight-influence').value);
    weights.support = parseFloat(document.getElementById('weight-support').value);

    document.getElementById('val-pagerank').innerText = weights.pagerank.toFixed(1);
    document.getElementById('val-influence').innerText = weights.influence.toFixed(1);
    document.getElementById('val-support').innerText = weights.support.toFixed(1);

    Graph.nodeVal(node => Math.max(3, computeCustomScore(node) * 300));

    // Refresh custom score display if a node is selected
    if (selectedNode) {
        refreshCustomScoreDisplay();
    }
}

function refreshCustomScoreDisplay() {
    if (!selectedNode) return;
    const maxScore = Math.max(...graphData.nodes.map(n => computeCustomScore(n)), 0.001);
    const scorePct = (computeCustomScore(selectedNode) / maxScore * 100).toFixed(1);
    const scoreEl = document.getElementById('custom-score-value');
    if (scoreEl) scoreEl.innerText = scorePct + '%';
}

// =============================================================================
// Info Tooltips
// =============================================================================

function setupInfoButtons() {
    document.querySelectorAll('.info-btn').forEach(btn => {
        const key = btn.dataset.info;
        if (key && INFO_TEXTS[key]) {
            btn.title = INFO_TEXTS[key];  // Hover tooltip
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showInfoModal(INFO_TEXTS[key]);
            });
        }
    });
}

function showInfoModal(text) {
    let modal = document.getElementById('info-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'info-modal';
        modal.className = 'info-modal';
        modal.innerHTML = `<div class="info-modal-content"><p></p><button onclick="closeInfoModal()">OK</button></div>`;
        document.body.appendChild(modal);
    }
    modal.querySelector('p').innerText = text;
    modal.classList.add('visible');
}

function closeInfoModal() {
    const modal = document.getElementById('info-modal');
    if (modal) modal.classList.remove('visible');
}

// =============================================================================
// Cluster Spheres
// =============================================================================

function renderClusterSpheres() {
    const scene = Graph.scene();

    // Clear existing
    clusterSphereMeshes.forEach(m => scene.remove(m));
    clusterSphereMeshes = [];

    if (!showClusterSpheres) {
        console.log("Cluster spheres OFF");
        return;
    }

    // Safety check for THREE
    if (!window.THREE || !window.THREE.SphereGeometry) {
        console.error("THREE.js not fully loaded, cannot render spheres. Check window.THREE:", window.THREE);
        return;
    }
    const THREE = window.THREE;

    // Allow in all views now, as we have positions
    console.log(`Rendering spheres for ${graphData.clusters.length} clusters. View: ${currentView}`);

    const scale = 20;  // UMAP scale factor matching applyViewPositions

    graphData.clusters.forEach(cluster => {
        if (!cluster.centroid) {
            console.warn(`Cluster ${cluster.id} has no centroid`);
            return;
        }

        const color = CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length];

        // Sphere
        const radius = 6 + Math.sqrt(cluster.count) * 2.5;
        const geometry = new THREE.SphereGeometry(radius, 32, 32);
        const material = new THREE.MeshLambertMaterial({ // Use Lambert for better 3D look
            color: color,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide
        });
        const sphere = new THREE.Mesh(geometry, material);

        // Position depends on view, but centroid is static UMAP coord usually
        // We need to match where nodes are. 
        // If view is 'force', clusters might not align unless we calculate force centroids.
        // For 'semantic'/'hybrid', we use the UMAP centroids.

        let cx = cluster.centroid.x * scale;
        let cy = cluster.centroid.y * scale;
        let cz = cluster.centroid.z * scale;

        // In force layout, clusters are scattered, so spheres don't make sense unless we track them.
        // But user wants them visible so we allow it, but maybe warn or assume semantic placement.
        if (currentView === 'force') {
            // For force view, we can't easily show static spheres unless we compute live centroids.
            // We'll skip for force to avoid confusion, or use average of current node positions.
            return;
        } else if (currentView === 'hybrid') {
            // Mix not needed for centroid as it's purely semantic property usually
            // But if nodes moved, sphere should too. 
            // Simplification: Render at scale
        }

        sphere.position.set(cx, cy, cz);
        scene.add(sphere);
        clusterSphereMeshes.push(sphere);

        // Label sprite
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 512;
        canvas.height = 128; // taller
        ctx.fillStyle = color;
        ctx.font = 'bold 32px Arial'; // Bigger font
        ctx.textAlign = 'center';
        ctx.fillText(cluster.name, 256, 64);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.position.set(cx, cy + radius + 10, cz);
        sprite.scale.set(40, 10, 1);
        scene.add(sprite);
        clusterSphereMeshes.push(sprite);
    });

    console.log(`Rendered ${clusterSphereMeshes.length / 2} spheres`);
}

function toggleClusterSpheres() {
    showClusterSpheres = !showClusterSpheres;
    console.log(`Cluster spheres: ${showClusterSpheres}`);
    renderClusterSpheres();
}

// Phase 8: Toggle cluster name labels
function toggleClusterLabels() {
    showClusterLabels = !showClusterLabels;
    console.log(`Cluster labels: ${showClusterLabels}`);
    renderClusterLabels();
}

// Phase 8: Render floating cluster name labels
function renderClusterLabels() {
    const scene = Graph.scene();
    if (!scene) return;

    // Clear existing
    clusterLabelSprites.forEach(sprite => scene.remove(sprite));
    clusterLabelSprites = [];

    if (!showClusterLabels || !window.THREE) return;

    const scale = 20;
    const THREE = window.THREE;

    graphData.clusters.forEach(cluster => {
        if (!cluster.centroid) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 512;
        canvas.height = 96;

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.beginPath();
        ctx.roundRect(0, 0, 512, 96, 12);
        ctx.fill();

        // Cluster name in its color
        const color = CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length];
        ctx.fillStyle = color;
        ctx.font = 'bold 28px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(cluster.name, 256, 38);

        // Node count
        ctx.fillStyle = '#aaaaaa';
        ctx.font = '18px Arial';
        ctx.fillText(`${cluster.count} nodes`, 256, 70);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false  // Always visible
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.set(
            cluster.centroid.x * scale,
            cluster.centroid.y * scale + 25,
            cluster.centroid.z * scale
        );
        sprite.scale.set(32, 6, 1);
        sprite.userData = { clusterId: cluster.id };

        scene.add(sprite);
        clusterLabelSprites.push(sprite);
    });

    console.log(`Rendered ${clusterLabelSprites.length} cluster labels`);
}

// =============================================================================
// Similarity Heatmap with Code Comparison
// =============================================================================

function renderHeatmap() {
    const container = document.getElementById('heatmap-container');
    if (!container) return;

    const pairs = graphData.similarity_pairs.slice(0, 25);
    if (pairs.length === 0) {
        container.innerHTML = '<p>No similarity data</p>';
        return;
    }

    let html = '<table class="heatmap-table"><thead><tr><th>Source</th><th>Target</th><th>Sim</th></tr></thead><tbody>';

    pairs.forEach((pair, idx) => {
        const srcLabel = pair.source_label || pair.source.split('::').pop();
        const tgtLabel = pair.target_label || pair.target.split('::').pop();
        const pct = (pair.similarity * 100).toFixed(0);
        const hue = Math.round(pair.similarity * 120);
        html += `<tr onclick="showCodeComparison(${idx})" class="clickable-row">
            <td title="${pair.source}">${srcLabel}</td>
            <td title="${pair.target}">${tgtLabel}</td>
            <td style="background:hsl(${hue},70%,35%);text-align:center">${pct}%</td>
        </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

async function showCodeComparison(pairIndex) {
    const pair = graphData.similarity_pairs[pairIndex];
    if (!pair) return;

    const panel = document.getElementById('comparison-panel');
    panel.classList.remove('hidden');

    document.getElementById('comp-src-label').innerText = pair.source_label || pair.source.split('::').pop();
    document.getElementById('comp-tgt-label').innerText = pair.target_label || pair.target.split('::').pop();
    document.getElementById('comp-similarity').innerText = `${(pair.similarity * 100).toFixed(1)}% similar`;

    // Load source code
    const srcFile = pair.source_file || pair.source.split('::')[0];
    const tgtFile = pair.target_file || pair.target.split('::')[0];

    try {
        const [srcRes, tgtRes] = await Promise.all([
            fetch(`/api/source/${encodeURIComponent(srcFile)}`),
            fetch(`/api/source/${encodeURIComponent(tgtFile)}`)
        ]);

        document.getElementById('comp-src-code').innerText = srcRes.ok ?
            (await srcRes.text()).slice(0, 2000) : 'Source unavailable';
        document.getElementById('comp-tgt-code').innerText = tgtRes.ok ?
            (await tgtRes.text()).slice(0, 2000) : 'Source unavailable';
    } catch (e) {
        document.getElementById('comp-src-code').innerText = 'Error loading';
        document.getElementById('comp-tgt-code').innerText = 'Error loading';
    }

    // Highlight nodes
    const srcNode = graphData.nodes.find(n => n.id === pair.source);
    if (srcNode) focusNode(srcNode);
}

function closeComparison() {
    document.getElementById('comparison-panel').classList.add('hidden');
}

function toggleHeatmap() {
    document.getElementById('heatmap-panel').classList.toggle('hidden');
}

// =============================================================================
// Info Tooltips
// =============================================================================

function showInfo(key) {
    const text = INFO_TEXTS[key] || 'No description available';
    alert(text);  // Simple implementation - could be replaced with tooltip
}

// =============================================================================
// View Modes
// =============================================================================

function setView(view) {
    currentView = view;

    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${view}`).classList.add('active');
    document.getElementById('blend-control').style.display = view === 'hybrid' ? 'block' : 'none';

    // Handle tree view visibility
    const treeView = document.getElementById('tree-view');
    const graph3d = document.getElementById('3d-graph');
    const sidebar = document.getElementById('sidebar');

    if (view === 'tree') {
        treeView.classList.remove('hidden');
        graph3d.style.opacity = '0';
        graph3d.style.pointerEvents = 'none';
        sidebar.style.display = 'none';
        renderTreeView();
    } else {
        treeView.classList.add('hidden');
        graph3d.style.opacity = '1';
        graph3d.style.pointerEvents = 'auto';
        sidebar.style.display = 'block';
        applyViewPositions();
        // Re-render cluster spheres for new view
        setTimeout(() => renderClusterSpheres(), 500);
    }
}

function applyViewPositions() {
    graphData.nodes.forEach(node => {
        const forceX = node.force_x ?? node.x ?? 0;
        const forceY = node.force_y ?? node.y ?? 0;
        const forceZ = node.force_z ?? node.z ?? 0;

        const umapX = (node.umap_x ?? 0) * 20;
        const umapY = (node.umap_y ?? 0) * 20;
        const umapZ = (node.umap_z ?? 0) * 20;

        if (currentView === 'force') {
            node.fx = forceX; node.fy = forceY; node.fz = forceZ;
        } else if (currentView === 'semantic') {
            node.fx = umapX; node.fy = umapY; node.fz = umapZ;
        } else {
            node.fx = forceX * (1 - hybridBlend) + umapX * hybridBlend;
            node.fy = forceY * (1 - hybridBlend) + umapY * hybridBlend;
            node.fz = forceZ * (1 - hybridBlend) + umapZ * hybridBlend;
        }
    });

    Graph.graphData(graphData);

    setTimeout(() => {
        if (currentView === 'force') {
            graphData.nodes.forEach(node => { node.fx = null; node.fy = null; node.fz = null; });
        }
    }, 1000);
}

function setBlend(value) {
    hybridBlend = parseFloat(value);
    document.getElementById('blend-value').innerText = `${Math.round(hybridBlend * 100)}%`;
    if (currentView === 'hybrid') {
        applyViewPositions();
        setTimeout(() => renderClusterSpheres(), 600);
    }
}

function focusNode(node) {
    const distance = 60;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
    Graph.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node, 1500
    );
}

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    Graph.backgroundColor(isDarkTheme ? '#0a0a1a' : '#f0f0f0');
    document.body.classList.toggle('light-theme', !isDarkTheme);
}

async function showDetails(node) {
    const panel = document.getElementById('details-panel');
    panel.classList.remove('hidden');

    document.getElementById('node-label').innerText = node.label;

    const cluster = graphData.clusters.find(c => c.id === node.cluster_id);
    const clusterName = cluster ? cluster.name : 'None';

    // Calculate max values for percentage display
    const maxInfluence = Math.max(...graphData.nodes.map(n => n.neighbor_influence || 0), 0.001);
    const maxSupport = Math.max(...graphData.nodes.map(n => n.neighbor_support || 0), 0.001);
    const maxScore = Math.max(...graphData.nodes.map(n => computeCustomScore(n)), 0.001);

    const infPct = ((node.neighbor_influence || 0) / maxInfluence * 100).toFixed(1);
    const supPct = ((node.neighbor_support || 0) / maxSupport * 100).toFixed(1);
    const scorePct = (computeCustomScore(node) / maxScore * 100).toFixed(1);

    document.getElementById('node-meta').innerHTML = `
        <div><strong>Type:</strong> ${node.type}</div>
        <div><strong>Layer:</strong> <span style="color:${LAYER_COLORS[node.layer]}">${node.layer}</span></div>
        <div><strong>Cluster:</strong> ${clusterName}</div>
        <div><strong>PageRank:</strong> ${(node.centrality * 100).toFixed(2)}%</div>
        <div><strong>Neighbor Influence:</strong> ${infPct}%</div>
        <div><strong>Neighbor Support:</strong> ${supPct}%</div>
        <div><strong>Custom Score:</strong> <span id="custom-score-value">${scorePct}%</span></div>
        <div><strong>In/Out:</strong> ${node.in_degree ?? 0} / ${node.out_degree ?? 0}</div>
        <div class="edge-legend"><span style="color:#ff5050">● Incoming</span> <span style="color:#0096ff">● Outgoing</span></div>
    `;

    if (node.file) {
        document.getElementById('node-source').innerText = "Loading...";
        try {
            const res = await fetch(`/api/source/${encodeURIComponent(node.file)}`);
            if (res.ok) {
                const text = await res.text();
                document.getElementById('node-source').innerText = text.slice(0, 3000) + (text.length > 3000 ? "\n..." : "");
            } else {
                document.getElementById('node-source').innerText = "Source unavailable";
            }
        } catch (e) {
            document.getElementById('node-source').innerText = "Error";
        }
    }
}

function closeDetails() {
    document.getElementById('details-panel').classList.add('hidden');
    selectedNode = null;
    updateLinkHighlighting();
}

async function performSearch() {
    const query = document.getElementById('semantic-search').value;
    if (!query) return;

    const btn = document.querySelector('.search-box button');
    btn.disabled = true;
    btn.innerText = 'Searching...';

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        alert(`Found ${data.results?.length || 0} results. Check console.`);
    } catch (e) {
        alert("Search error: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerText = 'Ask';
    }
}

// Phase 4: Enhanced centrality filter with neighbor visibility
let currentCentralityThreshold = 0.005;

function filterByCentrality(threshold) {
    currentCentralityThreshold = parseFloat(threshold);
    document.getElementById('centrality-value').innerText = `${(currentCentralityThreshold * 100).toFixed(1)}%`;

    // Pre-compute neighbor sets for visibility logic
    const neighborSets = new Map();
    graphData.links.forEach(link => {
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
        if (!neighborSets.has(srcId)) neighborSets.set(srcId, new Set());
        if (!neighborSets.has(tgtId)) neighborSets.set(tgtId, new Set());
        neighborSets.get(srcId).add(tgtId);
        neighborSets.get(tgtId).add(srcId);
    });

    graphData.nodes.forEach(node => {
        const meetsThreshold = (node.centrality || 0) >= currentCentralityThreshold;
        const isFile = node.type === 'file';
        const isNeighborOfSelected = selectedNode &&
            neighborSets.get(selectedNode.id)?.has(node.id);
        const isSelected = selectedNode && node.id === selectedNode.id;

        node.__visible = meetsThreshold || isFile || isNeighborOfSelected || isSelected;
    });

    Graph.nodeVisibility(node => node.__visible !== false);
}

// =============================================================================
// Tree View - Full View Mode
// =============================================================================

let treeData = null;
let treeSelectedNode = null;
let treeConnectedNodes = new Set();

// Build hierarchical tree structure from graph nodes
function buildTreeData() {
    const tree = { name: 'root', type: 'root', children: {}, nodes: [] };

    // Pre-compute max score for normalization
    const maxScore = Math.max(...graphData.nodes.map(n => computeCustomScore(n)), 0.001);

    graphData.nodes.forEach(node => {
        // Parse the node ID to extract hierarchy
        // Format: "path/to/file.py::ClassName::method" or "path/to/file.py::function"
        const parts = node.id.split('::');
        const filePath = parts[0] || '';
        const pathParts = filePath.replace(/\\/g, '/').split('/');

        // Navigate/create directory structure
        let current = tree;

        // Add directories
        for (let i = 0; i < pathParts.length - 1; i++) {
            const dirName = pathParts[i];
            if (!dirName) continue;
            if (!current.children[dirName]) {
                current.children[dirName] = {
                    name: dirName,
                    type: 'directory',
                    children: {},
                    nodes: []
                };
            }
            current = current.children[dirName];
        }

        // Add file
        const fileName = pathParts[pathParts.length - 1] || 'unknown';
        if (!current.children[fileName]) {
            current.children[fileName] = {
                name: fileName,
                type: 'file',
                children: {},
                nodes: [],
                filePath: filePath
            };
        }
        current = current.children[fileName];

        // Determine node type and add to hierarchy
        const score = computeCustomScore(node) / maxScore * 100;
        const nodeEntry = {
            id: node.id,
            name: node.label || parts[parts.length - 1] || 'unknown',
            type: node.type || 'function',
            nodeData: node,
            score: score
        };

        // If there's a class (middle part)
        if (parts.length === 3) {
            const className = parts[1];
            if (!current.children[className]) {
                current.children[className] = {
                    name: className,
                    type: 'class',
                    children: {},
                    nodes: []
                };
            }
            current.children[className].nodes.push(nodeEntry);
        } else {
            // Direct function in file
            current.nodes.push(nodeEntry);
        }
    });

    return tree;
}

// Convert tree children object to sorted array
function flattenTreeChildren(node) {
    const result = [];

    // Add child directories/files/classes first
    const childKeys = Object.keys(node.children).sort((a, b) => {
        const aType = node.children[a].type;
        const bType = node.children[b].type;
        // Directories first, then files, then classes
        const order = { directory: 0, file: 1, class: 2 };
        if (order[aType] !== order[bType]) return order[aType] - order[bType];
        return a.localeCompare(b);
    });

    childKeys.forEach(key => {
        const child = node.children[key];
        result.push({
            ...child,
            children: flattenTreeChildren(child)
        });
    });

    // Add nodes (functions/methods)
    node.nodes.sort((a, b) => b.score - a.score).forEach(n => {
        result.push({
            ...n,
            type: n.type === 'class' ? 'class' : 'function',
            children: []
        });
    });

    return result;
}

// Get icon for node type
function getTreeIcon(type) {
    switch (type) {
        case 'directory': return '📁';
        case 'file': return '📄';
        case 'class': return '🔷';
        case 'function': return '⚡';
        default: return '📦';
    }
}

// Get score class for styling
function getScoreClass(score) {
    if (score < 33) return 'low';
    if (score < 66) return 'medium';
    return 'high';
}

// Render the tree view
function renderTreeView() {
    if (!treeData) {
        treeData = buildTreeData();
    }

    const container = document.getElementById('tree-container');
    const flatTree = flattenTreeChildren(treeData);

    container.innerHTML = renderTreeNodes(flatTree, 0);

    // Clear details panel
    updateTreeDetails(null);
}

// Render tree nodes recursively
function renderTreeNodes(nodes, depth) {
    if (!nodes || nodes.length === 0) return '';

    let html = '';
    nodes.forEach(node => {
        const hasChildren = node.children && node.children.length > 0;
        const isLeaf = node.nodeData !== undefined;
        const nodeClass = `tree-node tree-node--${node.type}`;
        const arrowClass = hasChildren ? 'tree-arrow expanded' : 'tree-arrow empty';
        const nodeId = node.id || `${node.type}-${node.name}`;

        // Check if connected to selected node
        const isConnected = treeConnectedNodes.has(node.id);
        const isSelected = treeSelectedNode && treeSelectedNode.id === node.id;
        const isDimmed = treeSelectedNode && !isConnected && !isSelected && isLeaf;

        let headerClass = 'tree-node-header';
        if (isSelected) headerClass += ' selected';
        else if (isConnected) headerClass += ' connected';
        else if (isDimmed) headerClass += ' dimmed';

        // Escape backslashes for onclick handler (Windows paths)
        const escapedNodeId = nodeId.replace(/\\/g, '\\\\');

        html += `<div class="${nodeClass}" data-node-id="${nodeId}">`;
        html += `<div class="${headerClass}" onclick="onTreeNodeClick(event, '${escapedNodeId}')" data-expandable="${hasChildren}">`;
        html += `<span class="${arrowClass}">${hasChildren ? '▶' : ''}</span>`;
        html += `<span class="tree-icon">${getTreeIcon(node.type)}</span>`;
        html += `<span class="tree-label" title="${node.name}">${node.name}</span>`;

        // Add score bar for leaf nodes
        if (isLeaf && node.score !== undefined) {
            html += `<div class="tree-score">`;
            html += `<div class="tree-score-bar ${getScoreClass(node.score)}" style="width: ${node.score}%"></div>`;
            html += `</div>`;
        }

        html += `</div>`;

        // Render children
        if (hasChildren) {
            html += `<div class="tree-children">`;
            html += renderTreeNodes(node.children, depth + 1);
            html += `</div>`;
        }

        html += `</div>`;
    });

    return html;
}

// Handle tree node click
function onTreeNodeClick(event, nodeId) {
    event.stopPropagation();

    const header = event.currentTarget;
    const isExpandable = header.getAttribute('data-expandable') === 'true';

    // Toggle expand/collapse for parent nodes
    if (isExpandable) {
        const arrow = header.querySelector('.tree-arrow');
        const children = header.nextElementSibling;
        if (children && children.classList.contains('tree-children')) {
            children.classList.toggle('collapsed');
            arrow.classList.toggle('expanded');
        }
    }

    // Find the actual graph node
    const graphNode = graphData.nodes.find(n => n.id === nodeId);

    if (graphNode) {
        treeSelectedNode = graphNode;

        // Find connected nodes
        treeConnectedNodes = new Set();
        graphData.links.forEach(link => {
            const srcId = typeof link.source === 'object' ? link.source.id : link.source;
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
            if (srcId === nodeId) treeConnectedNodes.add(tgtId);
            if (tgtId === nodeId) treeConnectedNodes.add(srcId);
        });

        // Update details panel
        updateTreeDetails(graphNode);

        // Update visual highlighting in tree
        updateTreeHighlighting();
    }
}

// Update tree node highlighting based on selection
function updateTreeHighlighting() {
    const container = document.getElementById('tree-container');
    const headers = container.querySelectorAll('.tree-node-header');

    headers.forEach(header => {
        const nodeDiv = header.closest('.tree-node');
        const nodeId = nodeDiv?.getAttribute('data-node-id');
        const isLeaf = graphData.nodes.some(n => n.id === nodeId);

        header.classList.remove('selected', 'connected', 'dimmed');

        if (treeSelectedNode) {
            if (nodeId === treeSelectedNode.id) {
                header.classList.add('selected');
            } else if (treeConnectedNodes.has(nodeId)) {
                header.classList.add('connected');
            } else if (isLeaf) {
                header.classList.add('dimmed');
            }
        }
    });
}

// Update the tree details panel with rich metrics
function updateTreeDetails(node) {
    const infoPanel = document.getElementById('tree-node-info');
    const outgoingList = document.getElementById('tree-outgoing');
    const incomingList = document.getElementById('tree-incoming');
    const outCount = document.getElementById('out-count');
    const inCount = document.getElementById('in-count');

    // Clear SVG connections
    clearSvgConnections();

    if (!node) {
        infoPanel.innerHTML = '<div class="tree-hint">Select a node to explore its dependencies</div>';
        const emptyHtml = `
            <li class="empty-state-visual">
                <div class="empty-message">No connections</div>
                <iframe src="favicon.html" style="width: 100%; height: 200px; border: none; opacity: 0.6; pointer-events: none; margin-top: 1rem;"></iframe>
            </li>`;
        outgoingList.innerHTML = emptyHtml;
        incomingList.innerHTML = emptyHtml;
        if (outCount) outCount.textContent = '0';
        if (inCount) inCount.textContent = '0';
        return;
    }

    // Calculate normalized scores
    const maxComposite = Math.max(...graphData.nodes.map(n => n.composite_score || 0), 0.001);
    const maxCentrality = Math.max(...graphData.nodes.map(n => n.centrality || 0), 0.001);
    const maxInfluence = Math.max(...graphData.nodes.map(n => n.neighbor_influence || 0), 0.001);
    const maxSupport = Math.max(...graphData.nodes.map(n => n.neighbor_support || 0), 0.001);

    const compositePct = ((node.composite_score || 0) / maxComposite * 100).toFixed(1);
    const centralityPct = ((node.centrality || 0) / maxCentrality * 100).toFixed(1);
    const influencePct = ((node.neighbor_influence || 0) / maxInfluence * 100).toFixed(1);
    const supportPct = ((node.neighbor_support || 0) / maxSupport * 100).toFixed(1);

    // Cluster info
    const cluster = graphData.clusters.find(c => c.id === node.cluster_id);
    const clusterName = cluster ? cluster.name : 'Unclustered';

    // Layer color
    const layerColor = LAYER_COLORS[node.layer] || '#888';
    const layerLabel = node.layer || 'UNKNOWN';

    // Build info panel with all metrics
    infoPanel.innerHTML = `
        <div class="node-title">${node.label}</div>
        <div class="node-type-badge" style="background:${layerColor}20;color:${layerColor};border:1px solid ${layerColor}">${layerLabel}</div>
        
        <div class="metrics-grid">
            <div class="metric">
                <span class="metric-label">Type</span>
                <span class="metric-value">${node.type}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Cluster</span>
                <span class="metric-value">${clusterName}</span>
            </div>
            <div class="metric">
                <span class="metric-label">In-Degree</span>
                <span class="metric-value in-val">${node.in_degree ?? 0}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Out-Degree</span>
                <span class="metric-value out-val">${node.out_degree ?? 0}</span>
            </div>
        </div>

        <div class="score-section">
            <div class="score-row">
                <span class="score-name">Composite Score</span>
                <div class="score-track"><div class="score-fill composite" style="width:${compositePct}%"></div></div>
                <span class="score-pct">${compositePct}%</span>
            </div>
            <div class="score-row">
                <span class="score-name">PageRank</span>
                <div class="score-track"><div class="score-fill centrality" style="width:${centralityPct}%"></div></div>
                <span class="score-pct">${centralityPct}%</span>
            </div>
            <div class="score-row">
                <span class="score-name">Influence</span>
                <div class="score-track"><div class="score-fill influence" style="width:${influencePct}%"></div></div>
                <span class="score-pct">${influencePct}%</span>
            </div>
            <div class="score-row">
                <span class="score-name">Support</span>
                <div class="score-track"><div class="score-fill support" style="width:${supportPct}%"></div></div>
                <span class="score-pct">${supportPct}%</span>
            </div>
        </div>
    `;

    // Build connections with proper categorization
    const outgoing = { calls: [], imports: [], contains: [] };
    const incoming = { calls: [], imports: [], contains: [] };

    graphData.links.forEach(link => {
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

        if (srcId === node.id) {
            const tgtNode = graphData.nodes.find(n => n.id === tgtId);
            if (tgtNode) {
                const category = outgoing[link.type] || outgoing.calls;
                category.push({ node: tgtNode, type: link.type });
            }
        }
        if (tgtId === node.id) {
            const srcNode = graphData.nodes.find(n => n.id === srcId);
            if (srcNode) {
                const category = incoming[link.type] || incoming.calls;
                category.push({ node: srcNode, type: link.type });
            }
        }
    });

    const totalOutgoing = outgoing.calls.length + outgoing.imports.length + outgoing.contains.length;
    const totalIncoming = incoming.calls.length + incoming.imports.length + incoming.contains.length;

    if (outCount) outCount.textContent = totalOutgoing;
    if (inCount) inCount.textContent = totalIncoming;

    // Render outgoing connections grouped by type
    outgoingList.innerHTML = renderConnectionGroup(outgoing, 'outgoing');
    incomingList.innerHTML = renderConnectionGroup(incoming, 'incoming');

    // Draw SVG connections
    drawSvgConnections(node, outgoing, incoming);

    // Load source preview
    loadTreeSourcePreview(node);

    // Enable/disable View in 3D button
    const btn3d = document.getElementById('btn-view-3d');
    if (btn3d) btn3d.disabled = !node;
}

// Render connection group HTML with clickable items that show source
function renderConnectionGroup(connections, direction) {
    let html = '';
    const colors = { calls: '#00ff88', imports: '#ffd700', contains: '#666' };
    const icons = { calls: '→', imports: '⇢', contains: '⊃' };

    ['calls', 'imports', 'contains'].forEach(type => {
        const items = connections[type];
        if (items.length === 0) return;

        html += `<li class="conn-group-header" style="color:${colors[type]}">${icons[type]} ${type} (${items.length})</li>`;
        items.forEach(conn => {
            const score = conn.node.composite_score || 0;
            const maxScore = Math.max(...graphData.nodes.map(n => n.composite_score || 0), 0.001);
            const scorePct = (score / maxScore * 100).toFixed(0);
            // Escape backslashes for onclick handler
            const escapedId = conn.node.id.replace(/\\/g, '\\\\');

            html += `
                <li class="conn-item" onclick="showConnectionSource('${escapedId}')" data-node-id="${conn.node.id}">
                    <span class="conn-layer" style="color:${LAYER_COLORS[conn.node.layer] || '#888'}">●</span>
                    <span class="conn-name">${conn.node.label}</span>
                    <span class="conn-score" title="Composite: ${scorePct}%">${scorePct}%</span>
                </li>
            `;
        });
    });

    if (!html) {
        html = `
            <li class="empty-state-visual">
                <div class="empty-message">No connections</div>
                <iframe src="favicon.html" style="width: 100%; height: 200px; border: none; opacity: 0.6; pointer-events: none; margin-top: 1rem;"></iframe>
            </li>`;
    }

    return html;
}

// Clear SVG connections
function clearSvgConnections() {
    const svg = document.getElementById('tree-svg');
    if (svg) svg.innerHTML = '';
}

// Draw SVG connection arrows between selected node and its connections
function drawSvgConnections(selectedNode, outgoing, incoming) {
    const svg = document.getElementById('tree-svg');
    if (!svg) return;

    svg.innerHTML = ''; // Clear existing

    const treeView = document.getElementById('tree-view');
    if (!treeView) return;

    // Get the selected node element
    const selectedEl = document.querySelector(`[data-node-id="${selectedNode.id}"] .tree-node-header`);
    if (!selectedEl) return;

    const treeRect = treeView.getBoundingClientRect();
    const selectedRect = selectedEl.getBoundingClientRect();

    // Calculate center of selected node (relative to tree-view)
    const selX = selectedRect.left - treeRect.left + selectedRect.width;
    const selY = selectedRect.top - treeRect.top + selectedRect.height / 2;

    // Draw outgoing arrows (blue)
    const allOutgoing = [...(outgoing.calls || []), ...(outgoing.imports || []), ...(outgoing.contains || [])];
    allOutgoing.forEach(conn => {
        const targetEl = document.querySelector(`[data-node-id="${conn.node.id}"] .tree-node-header`);
        if (targetEl) {
            const targetRect = targetEl.getBoundingClientRect();
            const tgtX = targetRect.left - treeRect.left;
            const tgtY = targetRect.top - treeRect.top + targetRect.height / 2;
            drawArrow(svg, selX, selY, tgtX, tgtY, '#00bfff', conn.type);
        }
    });

    // Draw incoming arrows (red)
    const allIncoming = [...(incoming.calls || []), ...(incoming.imports || []), ...(incoming.contains || [])];
    allIncoming.forEach(conn => {
        const sourceEl = document.querySelector(`[data-node-id="${conn.node.id}"] .tree-node-header`);
        if (sourceEl) {
            const sourceRect = sourceEl.getBoundingClientRect();
            const srcX = sourceRect.left - treeRect.left + sourceRect.width;
            const srcY = sourceRect.top - treeRect.top + sourceRect.height / 2;
            drawArrow(svg, srcX, srcY, selX - 5, selY, '#ff5555', conn.type);
        }
    });
}

// Draw a curved arrow in SVG
function drawArrow(svg, x1, y1, x2, y2, color, type) {
    // Create a curved path
    const dx = x2 - x1;
    const dy = y2 - y1;
    const curve = Math.min(Math.abs(dx) * 0.3, 100);

    // Control points for bezier curve
    const cx1 = x1 + curve;
    const cy1 = y1;
    const cx2 = x2 - curve;
    const cy2 = y2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', type === 'contains' ? '1' : '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-opacity', '0.6');
    if (type === 'contains') {
        path.setAttribute('stroke-dasharray', '4,4');
    }
    svg.appendChild(path);

    // Draw arrowhead
    const angle = Math.atan2(y2 - cy2, x2 - cx2);
    const arrowSize = 8;
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const arrowPoints = [
        [x2, y2],
        [x2 - arrowSize * Math.cos(angle - 0.4), y2 - arrowSize * Math.sin(angle - 0.4)],
        [x2 - arrowSize * Math.cos(angle + 0.4), y2 - arrowSize * Math.sin(angle + 0.4)]
    ];
    arrow.setAttribute('points', arrowPoints.map(p => p.join(',')).join(' '));
    arrow.setAttribute('fill', color);
    arrow.setAttribute('fill-opacity', '0.8');
    svg.appendChild(arrow);
}

// Load source preview for tree view
async function loadTreeSourcePreview(node) {
    const sourceEl = document.getElementById('tree-source-code');
    const previewContainer = document.getElementById('tree-source-preview');

    if (!sourceEl) return;

    if (!node || !node.file) {
        sourceEl.innerText = 'No source file associated';
        if (previewContainer) previewContainer.style.display = 'none';
        return;
    }

    if (previewContainer) previewContainer.style.display = 'flex';
    sourceEl.innerText = 'Loading...';

    try {
        const res = await fetch(`/api/source/${encodeURIComponent(node.file)}`);
        if (res.ok) {
            const text = await res.text();
            // Show first 2000 chars with truncation indicator
            sourceEl.innerText = text.slice(0, 2000) + (text.length > 2000 ? '\n...(truncated)' : '');
        } else {
            sourceEl.innerText = 'Source unavailable';
        }
    } catch (e) {
        sourceEl.innerText = 'Error loading source: ' + e.message;
    }
}

// Sort tree nodes
function sortTreeBy(criteria) {
    treeData = null; // Force rebuild
    treeSortCriteria = criteria;
    renderTreeView();
}

let treeSortCriteria = 'name';

// Switch connection tab (outgoing/incoming)
function switchConnTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.conn-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    // Update lists
    document.querySelectorAll('.conn-list').forEach(list => {
        list.classList.toggle('active', list.id === `conn-${tab}`);
    });
}

// Show source preview for a connection (clickable item in connections list)
async function showConnectionSource(nodeId) {
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Highlight the clicked connection item
    document.querySelectorAll('.conn-item').forEach(item => {
        item.classList.toggle('active', item.dataset.nodeId === nodeId);
    });

    // Update source panel title
    const titleEl = document.getElementById('source-panel-title');
    const pathEl = document.getElementById('source-file-path');
    if (titleEl) titleEl.textContent = node.label;
    if (pathEl) pathEl.textContent = node.file || '';

    // Load source
    const sourceEl = document.getElementById('tree-source-code');
    if (!sourceEl) return;

    if (!node.file) {
        sourceEl.textContent = 'No source file associated';
        return;
    }

    sourceEl.textContent = 'Loading...';

    try {
        const res = await fetch(`/api/source/${encodeURIComponent(node.file)}`);
        if (res.ok) {
            const text = await res.text();
            sourceEl.textContent = text.slice(0, 3000) + (text.length > 3000 ? '\n...(truncated)' : '');
        } else {
            sourceEl.textContent = 'Source unavailable';
        }
    } catch (e) {
        sourceEl.textContent = 'Error: ' + e.message;
    }
}

// Select a node in the tree by ID
function selectTreeNodeById(nodeId) {
    const graphNode = graphData.nodes.find(n => n.id === nodeId);
    if (!graphNode) return;

    treeSelectedNode = graphNode;

    // Find connected nodes
    treeConnectedNodes = new Set();
    graphData.links.forEach(link => {
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
        if (srcId === nodeId) treeConnectedNodes.add(tgtId);
        if (tgtId === nodeId) treeConnectedNodes.add(srcId);
    });

    // Expand parents to show the node
    expandToNode(nodeId);

    // Update UI
    updateTreeDetails(graphNode);
    updateTreeHighlighting();

    // Scroll node into view (use CSS.escape for Windows paths with backslashes)
    const nodeElement = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (nodeElement) {
        nodeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Expand tree to show a specific node
function expandToNode(nodeId) {
    // Find all parent nodes and expand them
    const parts = nodeId.split('::');
    const filePath = parts[0].replace(/\\/g, '/');
    const pathParts = filePath.split('/').filter(p => p);

    let currentPath = '';
    pathParts.forEach((part, i) => {
        currentPath += (i > 0 ? '/' : '') + part;
        const nodeDiv = document.querySelector(`[data-node-id="directory-${part}"], [data-node-id="file-${part}"]`);
        if (nodeDiv) {
            const children = nodeDiv.querySelector('.tree-children');
            const arrow = nodeDiv.querySelector('.tree-arrow');
            if (children) children.classList.remove('collapsed');
            if (arrow) arrow.classList.add('expanded');
        }
    });

    // Also expand class if present
    if (parts.length === 3) {
        const classDiv = document.querySelector(`[data-node-id="class-${parts[1]}"]`);
        if (classDiv) {
            const children = classDiv.querySelector('.tree-children');
            const arrow = classDiv.querySelector('.tree-arrow');
            if (children) children.classList.remove('collapsed');
            if (arrow) arrow.classList.add('expanded');
        }
    }
}

// Navigate to node in 3D graph view
function navigateToNodeIn3D(nodeId) {
    const graphNode = graphData.nodes.find(n => n.id === nodeId);
    if (!graphNode) return;

    // Set as selected node
    selectedNode = graphNode;

    // Switch to force view (or keep current 3D view)
    setView('force');

    // Update highlighting and zoom
    updateLinkHighlighting();
    zoomToNodeContext(graphNode);
    showDetails(graphNode);
}

// Filter tree nodes by search query
function filterTreeNodes(query) {
    const container = document.getElementById('tree-container');
    const nodes = container.querySelectorAll('.tree-node');
    const lowerQuery = query.toLowerCase().trim();

    if (!lowerQuery) {
        // Show all nodes
        nodes.forEach(node => {
            node.style.display = '';
            const children = node.querySelector('.tree-children');
            if (children) children.classList.remove('collapsed');
        });
        return;
    }

    // Track which nodes match and their parents
    const matchingIds = new Set();
    const parentIds = new Set();

    graphData.nodes.forEach(node => {
        if (node.label?.toLowerCase().includes(lowerQuery) ||
            node.id?.toLowerCase().includes(lowerQuery)) {
            matchingIds.add(node.id);

            // Add parent path parts
            const parts = node.id.split('::');
            const pathParts = (parts[0] || '').replace(/\\/g, '/').split('/').filter(p => p);
            pathParts.forEach(p => parentIds.add(`directory-${p}`));
            pathParts.forEach(p => parentIds.add(`file-${p}`));
            if (parts.length === 3) parentIds.add(`class-${parts[1]}`);
        }
    });

    nodes.forEach(nodeDiv => {
        const nodeId = nodeDiv.getAttribute('data-node-id');
        const isMatch = matchingIds.has(nodeId) || parentIds.has(nodeId);
        nodeDiv.style.display = isMatch ? '' : 'none';

        // Expand matching nodes
        if (isMatch) {
            const children = nodeDiv.querySelector('.tree-children');
            const arrow = nodeDiv.querySelector('.tree-arrow');
            if (children) children.classList.remove('collapsed');
            if (arrow) arrow.classList.add('expanded');
        }
    });
}

// Legacy toggle function (now uses setView)
function toggleTreeView() {
    if (currentView === 'tree') {
        setView('force');
    } else {
        setView('tree');
    }
}

init();

