#!/usr/bin/env python3
"""
TLDR Brain - Modular Data Aggregation for Project Visualization

Generates brain.json with:
- Proper layer assignment from arch analysis
- Embeddings from BGE model
- UMAP 3D coordinates for semantic visualization
- Cluster assignments with meaningful names
- Enhanced centrality metrics with neighbor weighting

Usage:
    from tldr.brain import build_brain_for_project
    build_brain_for_project(project_path)
    
CLI:
    tldr brain build [path] [--output FILE]
    tldr brain serve [path] [--port PORT]
"""

import json
import subprocess
import sys
import os
from pathlib import Path
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple

import networkx as nx
import numpy as np

# Direct imports from tldr for rich data
try:
    from .api import get_file_tree, get_imports, get_code_structure
    TLDR_API_AVAILABLE = True
except ImportError:
    try:
        from tldr.api import get_file_tree, get_imports, get_code_structure
        TLDR_API_AVAILABLE = True
    except ImportError:
        TLDR_API_AVAILABLE = False


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class NodeMetrics:
    """Centrality and neighbor-weighted metrics for a node."""
    pagerank: float = 0.0
    in_degree: int = 0
    out_degree: int = 0
    neighbor_influence: float = 0.0  # Sum of predecessors' pagerank
    neighbor_support: float = 0.0    # Sum of successors' pagerank
    weighted_in_degree: float = 0.0  # Avg predecessor pagerank
    weighted_out_degree: float = 0.0 # Avg successor pagerank
    composite_score: float = 0.0     # Weighted combination


@dataclass
class BrainNode:
    """A node in the brain graph."""
    id: str
    type: str  # file, function, class
    label: str
    file: str
    layer: str = "UNKNOWN"
    metrics: NodeMetrics = field(default_factory=NodeMetrics)
    umap_x: float = 0.0
    umap_y: float = 0.0
    umap_z: float = 0.0
    has_embedding: bool = False
    cluster_id: int = -1
    is_dead: bool = False
    
    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        return {
            "id": self.id,
            "type": self.type,
            "label": self.label,
            "file": self.file,
            "layer": self.layer,
            "centrality": self.metrics.pagerank,
            "in_degree": self.metrics.in_degree,
            "out_degree": self.metrics.out_degree,
            "neighbor_influence": self.metrics.neighbor_influence,
            "neighbor_support": self.metrics.neighbor_support,
            "weighted_in_degree": self.metrics.weighted_in_degree,
            "weighted_out_degree": self.metrics.weighted_out_degree,
            "composite_score": self.metrics.composite_score,
            "umap_x": self.umap_x,
            "umap_y": self.umap_y,
            "umap_z": self.umap_z,
            "has_embedding": self.has_embedding,
            "cluster_id": self.cluster_id,
            "is_dead": self.is_dead,
        }


@dataclass
class Cluster:
    """A semantic cluster of nodes."""
    id: int
    name: str
    count: int
    members: list
    centroid: tuple = (0.0, 0.0, 0.0)


# =============================================================================
# TLDR Command Runners
# =============================================================================

def run_tldr_command(cmd: str, cwd: Path = None) -> Optional[dict]:
    """Run a tldr command and return JSON output."""
    print(f"  → {cmd}")
    try:
        # Set UTF-8 encoding env var for Windows compatibility
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        
        result = subprocess.run(
            cmd, 
            shell=True, 
            capture_output=True, 
            text=True,
            encoding='utf-8',
            errors='replace',
            check=True,
            cwd=str(cwd) if cwd else None,
            env=env
        )
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr[:200] if e.stderr else 'Unknown error'
        print(f"    Error: {stderr}")
        return None
    except json.JSONDecodeError as e:
        print(f"    JSON decode error: {e}")
        return None


def fetch_project_data(project_root: Path) -> dict:
    """Fetch all necessary data using direct API if available, else CLI."""
    print("Fetching project data...")
    
    # Warm up cache first (non-fatal if it fails)
    try:
        # Set UTF-8 encoding env var for Windows compatibility
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        
        print("  → Warming up cache...")
        result = subprocess.run(
            "tldr warm .", 
            shell=True, 
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            cwd=str(project_root),
            env=env
        )
        if result.returncode != 0:
            print(f"  Warning: tldr warm failed, continuing anyway...")
            if result.stderr:
                print(f"    {result.stderr[:200]}")
    except Exception as e:
        print(f"  Warning: tldr warm error: {e}, continuing anyway...")
    
    # Initialize data dict
    data = {}
    
    # Fetch calls
    print("  → Fetching calls...")
    try:
        data["calls"] = run_tldr_command("tldr calls .", cwd=project_root)
        print(f"    ✓ Calls: {len(data.get('calls', {}).get('edges', [])) if data.get('calls') else 0} edges")
    except Exception as e:
        print(f"    ✗ Calls error: {e}")
        data["calls"] = None
    
    # Fetch arch
    print("  → Fetching arch...")
    try:
        data["arch"] = run_tldr_command("tldr arch .", cwd=project_root)
        print(f"    ✓ Arch: {type(data.get('arch'))}")
    except Exception as e:
        print(f"    ✗ Arch error: {e}")
        data["arch"] = None
    
    # Fetch dead code
    print("  → Fetching dead code...")
    try:
        data["dead"] = run_tldr_command("tldr dead .", cwd=project_root)
        print(f"    ✓ Dead: {type(data.get('dead'))}")
    except Exception as e:
        print(f"    ✗ Dead error: {e}")
        data["dead"] = None
    
    if TLDR_API_AVAILABLE:
        print("  → Using direct TLDR API for structure and tree...")
        try:
            print("    → get_file_tree...")
            data["tree"] = get_file_tree(str(project_root))
            print(f"    ✓ Tree: {len(data.get('tree', {}).get('files', [])) if data.get('tree') else 0} files")
        except Exception as e:
            print(f"    ✗ Tree API error: {e}")
            import traceback
            traceback.print_exc()
            data["tree"] = run_tldr_command("tldr tree .", cwd=project_root)
        
        try:
            print("    → get_code_structure...")
            data["structure"] = get_code_structure(str(project_root), language="python")
            print(f"    ✓ Structure: {len(data.get('structure', {}).get('files', [])) if data.get('structure') else 0} files")
        except Exception as e:
            print(f"    ✗ Structure API error: {e}")
            import traceback
            traceback.print_exc()
            data["structure"] = run_tldr_command("tldr structure .", cwd=project_root)
    else:
        print("  → Using CLI for structure and tree...")
        data["tree"] = run_tldr_command("tldr tree .", cwd=project_root)
        data["structure"] = run_tldr_command("tldr structure .", cwd=project_root)
    
    print("  → Data fetch complete.")
    return data


# =============================================================================
# Graph Building
# =============================================================================

def build_graph(structure_data: dict, calls_data: dict) -> nx.DiGraph:
    """Build NetworkX directed graph from structure and call data."""
    print("Building graph...")
    G = nx.DiGraph()
    
    # Add nodes from structure
    for file_info in structure_data.get("files", []):
        fpath = file_info["path"]
        G.add_node(fpath, type="file", name=Path(fpath).name, file=fpath)
        
        for func in file_info.get("functions", []):
            node_id = f"{fpath}::{func}"
            G.add_node(node_id, type="function", file=fpath, name=func)
            G.add_edge(fpath, node_id, type="contains")
        
        for cls in file_info.get("classes", []):
            node_id = f"{fpath}::{cls}"
            G.add_node(node_id, type="class", file=fpath, name=cls)
            G.add_edge(fpath, node_id, type="contains")
    
    # Add call edges
    for edge in calls_data.get("edges", []):
        from_id = f"{edge['from_file']}::{edge['from_func']}"
        to_id = f"{edge['to_file']}::{edge['to_func']}"
        if G.has_node(from_id) and G.has_node(to_id):
            G.add_edge(from_id, to_id, type="call", label="calls")
            
    # Add import edges (if API available to fetch them)
    if TLDR_API_AVAILABLE:
        print("  Adding import edges...")
        for file_info in structure_data.get("files", []):
            fpath = file_info["path"]
            try:
                imports = get_imports(fpath)
                for imp in imports:
                    module = imp.get("module")
                    if not module: continue
                    
                    # Try to find target node (naive matching for now)
                    target_file = None
                    for node in G.nodes():
                        if G.nodes[node].get("type") == "file":
                            if node.endswith(f"{module.split('.')[-1]}.py"):
                                target_file = node
                                break
                    
                    if target_file:
                        snippet = f"import {module}"
                        if imp.get("names"): 
                            snippet += f" ({', '.join(imp['names'])})"
                            
                        G.add_edge(fpath, target_file, type="import", label="imports", snippet=snippet)
                        
            except Exception:
                pass
    
    return G


# =============================================================================
# Centrality and Metrics
# =============================================================================

def compute_centrality_metrics(G: nx.DiGraph) -> Dict[str, NodeMetrics]:
    """Compute all centrality metrics including neighbor-weighted scores."""
    print("Computing centrality metrics...")
    
    # Base metrics
    pagerank = nx.pagerank(G, weight=None)
    in_degree = dict(G.in_degree())
    out_degree = dict(G.out_degree())
    
    metrics = {}
    
    for node_id in G.nodes():
        m = NodeMetrics()
        m.pagerank = pagerank.get(node_id, 0)
        m.in_degree = in_degree.get(node_id, 0)
        m.out_degree = out_degree.get(node_id, 0)
        
        # Neighbor influence: sum of predecessors' pagerank
        predecessors = list(G.predecessors(node_id))
        m.neighbor_influence = sum(pagerank.get(nbr, 0) for nbr in predecessors)
        
        # Neighbor support: sum of successors' pagerank
        successors = list(G.successors(node_id))
        m.neighbor_support = sum(pagerank.get(nbr, 0) for nbr in successors)
        
        # Weighted degrees: average neighbor pagerank
        m.weighted_in_degree = m.neighbor_influence / max(m.in_degree, 1)
        m.weighted_out_degree = m.neighbor_support / max(m.out_degree, 1)
        
        # Composite score with configurable weights
        m.composite_score = (
            m.pagerank * 0.6 +
            m.neighbor_influence * 0.2 +
            m.neighbor_support * 0.2
        )
        
        metrics[node_id] = m
    
    return metrics


# =============================================================================
# Layer Assignment
# =============================================================================

def assign_layers(nodes: List[BrainNode], arch_data: dict) -> None:
    """Assign layers (ENTRY/MIDDLE/LEAF) based on architecture analysis."""
    print("Assigning layers...")
    
    # Build lookup sets
    entry_set = set()
    leaf_set = set()
    
    for ep in arch_data.get("entry_points", []):
        key = f"{ep.get('file', '')}::{ep.get('function', '')}"
        entry_set.add(key)
        entry_set.add(ep.get('function', ''))
    
    for lf in arch_data.get("leaf_functions", []):
        key = f"{lf.get('file', '')}::{lf.get('function', '')}"
        leaf_set.add(key)
        leaf_set.add(lf.get('function', ''))
    
    for node in nodes:
        if node.type == "file":
            node.layer = "FILE"
        elif node.id in entry_set or node.label in entry_set:
            node.layer = "ENTRY"
        elif node.id in leaf_set or node.label in leaf_set:
            node.layer = "LEAF"
        else:
            node.layer = "MIDDLE"


# =============================================================================
# Embeddings and UMAP
# =============================================================================

def load_embeddings(project_path: Path) -> Tuple[np.ndarray, List[dict]]:
    """Load embeddings from semantic cache."""
    cache_dir = project_path / ".tldr" / "cache" / "semantic"
    metadata_file = cache_dir / "metadata.json"
    index_file = cache_dir / "index.faiss"
    
    if not metadata_file.exists():
        print("  Building semantic index...")
        from .semantic import build_semantic_index
        build_semantic_index(str(project_path), lang="python", show_progress=True)
    
    import faiss
    index = faiss.read_index(str(index_file))
    metadata = json.loads(metadata_file.read_text())
    
    # Reconstruct embeddings
    n_vectors = index.ntotal
    dimension = index.d
    embeddings = np.zeros((n_vectors, dimension), dtype=np.float32)
    for i in range(n_vectors):
        embeddings[i] = index.reconstruct(i)
    
    return embeddings, metadata.get("units", [])


def compute_umap_coordinates(embeddings: np.ndarray) -> np.ndarray:
    """Compute 3D UMAP coordinates from embeddings."""
    print("  Computing UMAP...")
    try:
        import umap
        reducer = umap.UMAP(n_components=3, n_neighbors=15, min_dist=0.1, random_state=42)
        return reducer.fit_transform(embeddings)
    except ImportError:
        print("    umap-learn not installed, using random positions")
        return np.random.randn(len(embeddings), 3) * 10


def apply_umap_to_nodes(nodes: List[BrainNode], project_path: Path) -> None:
    """Apply UMAP coordinates to nodes."""
    print("Computing embeddings and UMAP...")
    
    try:
        embeddings, units = load_embeddings(project_path)
        umap_coords = compute_umap_coordinates(embeddings)
        
        # Build mapping
        unit_map = {}
        for i, unit in enumerate(units):
            file_func = f"{unit['file']}::{unit['name']}"
            unit_map[file_func] = i
            unit_map[unit['name']] = i
        
        # Apply coordinates
        matched = 0
        for node in nodes:
            idx = unit_map.get(node.id) or unit_map.get(node.label)
            if idx is not None and idx < len(umap_coords):
                coords = umap_coords[idx]
                node.umap_x = float(coords[0])
                node.umap_y = float(coords[1])
                node.umap_z = float(coords[2])
                node.has_embedding = True
                matched += 1
            else:
                node.umap_x = float(np.random.randn() * 5)
                node.umap_y = float(np.random.randn() * 5)
                node.umap_z = float(np.random.randn() * 5)
        
        print(f"  Matched {matched}/{len(nodes)} nodes")
        
    except Exception as e:
        print(f"  Error: {e}")
        for node in nodes:
            node.umap_x = float(np.random.randn() * 10)
            node.umap_y = float(np.random.randn() * 10)
            node.umap_z = float(np.random.randn() * 10)


# =============================================================================
# Clustering
# =============================================================================

def cluster_nodes(nodes: List[BrainNode]) -> List[Cluster]:
    """Cluster nodes by UMAP position."""
    print("Clustering nodes...")
    
    # Extract coordinates
    coords = []
    valid_indices = []
    for i, node in enumerate(nodes):
        if node.has_embedding:
            coords.append([node.umap_x, node.umap_y, node.umap_z])
            valid_indices.append(i)
    
    if len(coords) < 5:
        return []
    
    coords = np.array(coords)
    
    # Cluster
    try:
        import hdbscan
        labels = hdbscan.HDBSCAN(min_cluster_size=3, min_samples=2).fit_predict(coords)
    except ImportError:
        from sklearn.cluster import KMeans
        n_clusters = min(10, len(coords) // 5)
        labels = KMeans(n_clusters=max(2, n_clusters), random_state=42, n_init=10).fit_predict(coords)
    
    # Assign to nodes
    for i, node_idx in enumerate(valid_indices):
        nodes[node_idx].cluster_id = int(labels[i])
    
    # Build cluster info
    cluster_members = defaultdict(list)
    cluster_coords = defaultdict(list)
    
    for i, node_idx in enumerate(valid_indices):
        cid = int(labels[i])
        if cid >= 0:
            cluster_members[cid].append(nodes[node_idx].label)
            cluster_coords[cid].append(coords[i])
    
    clusters = []
    for cid, members in cluster_members.items():
        centroid = tuple(np.mean(cluster_coords[cid], axis=0))
        clusters.append(Cluster(
            id=cid,
            name=generate_cluster_name(members),
            count=len(members),
            members=members[:5],
            centroid=centroid,
        ))
    
    print(f"  Created {len(clusters)} clusters")
    return clusters


def generate_cluster_name(members: List[str]) -> str:
    """Generate a meaningful name for a cluster."""
    if not members:
        return "Miscellaneous"
    
    # Common prefix
    if len(members) >= 2:
        prefix = members[0]
        for m in members[1:]:
            while prefix and not m.startswith(prefix):
                prefix = prefix[:-1]
        if len(prefix) > 3:
            return f"{prefix}*"
    
    # Keyword detection
    keywords = {
        "parse": "Parsing", "extract": "Extraction", "build": "Building",
        "get": "Getters", "set": "Setters", "find": "Search",
        "validate": "Validation", "load": "Loading", "save": "Persistence",
        "test": "Testing", "handle": "Handlers", "process": "Processing",
        "render": "Rendering", "init": "Initialization", "cfg": "Control Flow",
        "dfg": "Data Flow", "semantic": "Semantic", "import": "Imports",
    }
    
    counts = defaultdict(int)
    for m in members:
        for kw, name in keywords.items():
            if kw in m.lower():
                counts[name] += 1
    
    if counts:
        return max(counts, key=counts.get)
    
    return f"Group ({members[0][:15]}...)"


# =============================================================================
# Similarity Matrix
# =============================================================================

def compute_similarity_matrix(nodes: List[BrainNode], top_k: int = 50) -> List[dict]:
    """Compute top-k most similar node pairs (excluding same-name pairs)."""
    print("Computing similarity matrix...")
    
    # Get nodes with embeddings
    embedded_nodes = [n for n in nodes if n.has_embedding]
    if len(embedded_nodes) < 2:
        return []
    
    # Extract coordinates and compute pairwise distances
    coords = np.array([[n.umap_x, n.umap_y, n.umap_z] for n in embedded_nodes])
    
    # Compute pairwise Euclidean distances
    from scipy.spatial.distance import pdist, squareform
    distances = squareform(pdist(coords))
    
    # Exclude self and same-label pairs
    np.fill_diagonal(distances, np.inf)
    for i in range(len(embedded_nodes)):
        for j in range(i + 1, len(embedded_nodes)):
            # Skip if same label (same function name)
            if embedded_nodes[i].label == embedded_nodes[j].label:
                distances[i, j] = np.inf
                distances[j, i] = np.inf
    
    pairs = []
    for _ in range(min(top_k, len(embedded_nodes) * (len(embedded_nodes) - 1) // 2)):
        i, j = np.unravel_index(np.argmin(distances), distances.shape)
        if distances[i, j] == np.inf:
            break
        
        similarity = 1.0 / (1.0 + distances[i, j])
        pairs.append({
            "source": embedded_nodes[i].id,
            "source_label": embedded_nodes[i].label,
            "source_file": embedded_nodes[i].file,
            "target": embedded_nodes[j].id,
            "target_label": embedded_nodes[j].label,
            "target_file": embedded_nodes[j].file,
            "similarity": float(similarity),
        })
        
        distances[i, j] = np.inf
        distances[j, i] = np.inf
    
    print(f"  Found {len(pairs)} similar pairs")
    return pairs


# =============================================================================
# Main Builder
# =============================================================================

def build_brain_for_project(
    project_path: Path,
    output_path: Path = None,
    language: str = "python",
    use_cached: bool = False
) -> dict:
    """Build brain.json for a project - Main entry point.
    
    Args:
        project_path: Path to project root (can be str or Path)
        output_path: Path to output file (default: project_path/.tldr/brain.json)
        language: Programming language to analyze (default: python)
        use_cached: If True, skip rebuilding semantic index if it exists
        
    Returns:
        The brain dump dictionary
        
    Examples:
        # Build for current directory
        build_brain_for_project(Path.cwd())
        
        # Build for specific path with custom output
        build_brain_for_project(
            Path("/path/to/project"),
            output_path=Path("/path/to/project/custom_brain.json")
        )
    """
    # Normalize paths
    project_path = Path(project_path).resolve()
    
    if output_path is None:
        output_path = project_path / ".tldr" / "brain.json"
    else:
        output_path = Path(output_path)
        if not output_path.is_absolute():
            output_path = project_path / output_path
    
    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    print(f"Building brain.json for {project_path}")
    print(f"Output: {output_path}")
    
    # Change to project directory for tldr commands
    original_cwd = os.getcwd()
    try:
        os.chdir(project_path)
        
        # 1. Fetch data
        data = fetch_project_data(project_path)
        
        if not all([data.get("tree"), data.get("structure"), data.get("calls"), data.get("arch")]):
            print("Critical data missing. Aborting.")
            return None
        
        # 2. Build graph
        G = build_graph(data["structure"], data["calls"])
        
        # 3. Compute metrics
        metrics = compute_centrality_metrics(G)
        
        # 4. Create nodes
        nodes = []
        for node_id, attrs in G.nodes(data=True):
            node = BrainNode(
                id=node_id,
                type=attrs.get("type", "unknown"),
                label=attrs.get("name", Path(node_id).name),
                file=attrs.get("file", node_id),
                metrics=metrics.get(node_id, NodeMetrics()),
            )
            nodes.append(node)
        
        # 5. Assign layers
        assign_layers(nodes, data["arch"])
        
        # 6. Apply UMAP
        apply_umap_to_nodes(nodes, project_path)
        
        # 7. Cluster
        clusters = cluster_nodes(nodes)
        
        # 8. Compute similarity matrix
        similarity_pairs = compute_similarity_matrix(nodes)
        
        # 9. Build edges
        edges = [
            {
                "source": u, 
                "target": v, 
                "type": d.get("type", "related"),
                "label": d.get("label", ""),
                "snippet": d.get("snippet", "")
            }
            for u, v, d in G.edges(data=True)
        ]
        
        # 10. Output
        brain_dump = {
            "meta": {
                "project": str(project_path),
                "node_count": len(nodes),
                "edge_count": len(edges),
                "cluster_count": len(clusters),
            },
            "nodes": [n.to_dict() for n in nodes],
            "edges": edges,
            "clusters": [
                {
                    "id": c.id, 
                    "name": c.name, 
                    "count": c.count, 
                    "members": c.members,
                    "centroid": {"x": c.centroid[0], "y": c.centroid[1], "z": c.centroid[2]}
                } 
                for c in clusters
            ],
            "similarity_pairs": similarity_pairs,
            "file_tree": data["tree"],
        }
        
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(brain_dump, f, indent=2, ensure_ascii=False)
        
        print(f"\n✓ Brain dump saved to {output_path}")
        print(f"  Nodes: {len(nodes)}, Edges: {len(edges)}, Clusters: {len(clusters)}")
        return brain_dump
        
    finally:
        os.chdir(original_cwd)


# =============================================================================
# CLI Entry Point (for standalone script execution)
# =============================================================================

def main():
    """CLI entry point for standalone execution."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Build brain.json for project visualization",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Build for current directory (output to .tldr/brain.json)
    python -m tldr.brain .
    
    # Build for specific directory
    python -m tldr.brain /path/to/project
    
    # Custom output location
    python -m tldr.brain . -o custom_brain.json
    
    # Specify language
    python -m tldr.brain . --lang typescript
        """
    )
    parser.add_argument(
        "path", 
        nargs="?", 
        default=".", 
        help="Project directory (default: current directory)"
    )
    parser.add_argument(
        "-o", "--output",
        help="Output file (default: .tldr/brain.json)"
    )
    parser.add_argument(
        "--lang",
        default="python",
        help="Language to analyze (default: python)"
    )
    parser.add_argument(
        "--cached",
        action="store_true",
        help="Use cached semantic index if available"
    )
    
    args = parser.parse_args()
    
    project_path = Path(args.path).resolve()
    output_path = Path(args.output) if args.output else None
    
    if not project_path.exists():
        print(f"Error: Path not found: {project_path}", file=sys.stderr)
        sys.exit(1)
    
    result = build_brain_for_project(
        project_path=project_path,
        output_path=output_path,
        language=args.lang,
        use_cached=args.cached
    )
    
    if result is None:
        sys.exit(1)


if __name__ == "__main__":
    main()
