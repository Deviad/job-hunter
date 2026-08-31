#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow>=10"]
# ///
"""
reCAPTCHA image-grid tile analyzer.
Usage: uv run captcha-analyzer.py <image_path> <grid_size> <challenge_type>
Output: JSON with tile scores and recommended selections.
"""
import json, sys
from PIL import Image

def analyze_tile(tile):
    """Extract features from a single tile image."""
    w, h = tile.size
    features = {
        'avg_r': 0, 'avg_g': 0, 'avg_b': 0,
        'brightness': 0,
        'warm_pct': 0,       # reds/oranges
        'yellow_pct': 0,
        'red_pct': 0,
        'green_bright_pct': 0,
        'dark_bottom_pct': 0,
        'dark_pole_pct': 0,
        'stripe_contrast': 0,  # for zebra crossings
        'stripe_count': 0,      # number of horizontal stripe transitions
        'large_rect_warm': 0,   # for buses/vehicles
        'edge_density': 0,
    }
    
    rs = gs = bs = n = 0
    warm = yellow = red = green_bright = dark_bottom = dark_pole = 0
    bright_rows = 0
    row_bright = []
    
    for ty in range(h):
        row_bri = 0
        row_count = 0
        for tx in range(w):
            r, g, b = tile.getpixel((tx, ty))[:3]
            rs += r; gs += g; bs += b; n += 1
            bri = (r + g + b) / 3
            row_bri += bri
            row_count += 1
            
            # Warm colors (traffic lights, vehicles)
            if r > 100 and g > 80 and r > g * 0.8 and r > b * 1.2:
                warm += 1
            if r > 180 and g > 140 and b < 140:
                yellow += 1
            if r > 160 and g < 100 and b < 100:
                red += 1
            if g > 140 and r < 100 and b < 100:
                green_bright += 1
            
            # Structure
            if ty > h * 0.7 and bri < 60:
                dark_bottom += 1
            if bri < 40:
                dark_pole += 1
        
        avg_row_bri = row_bri / max(row_count, 1)
        if avg_row_bri > 160:
            bright_rows += 1
        row_bright.append(avg_row_bri)
    
    features['avg_r'] = rs / max(n, 1)
    features['avg_g'] = gs / max(n, 1)
    features['avg_b'] = bs / max(n, 1)
    features['brightness'] = (rs + gs + bs) / (3 * max(n, 1))
    features['warm_pct'] = warm / max(n, 1) * 100
    features['yellow_pct'] = yellow / max(n, 1) * 100
    features['red_pct'] = red / max(n, 1) * 100
    features['green_bright_pct'] = green_bright / max(n, 1) * 100
    features['dark_bottom_pct'] = dark_bottom / (max(n, 1) * 0.3) * 100
    features['dark_pole_pct'] = dark_pole / max(n, 1) * 100
    features['bright_row_pct'] = bright_rows / max(h, 1) * 100
    
    # Stripe analysis (for zebra crossings/pedestrian crossings)
    # Count transitions between bright and dark rows
    if len(row_bright) > 2:
        mean_bri = sum(row_bright) / len(row_bright)
        transitions = 0
        for i in range(1, len(row_bright)):
            diff = abs(row_bright[i] - row_bright[i-1])
            if diff > 50:
                transitions += 1
        features['stripe_contrast'] = transitions
        features['stripe_count'] = transitions // 2  # pair of transitions = 1 stripe
    
    # Edge density (Sobel-like)
    edge_count = 0
    for ty in range(1, h - 1):
        for tx in range(1, w - 1):
            r1, g1, b1 = tile.getpixel((tx-1, ty))[:3]
            r2, g2, b2 = tile.getpixel((tx+1, ty))[:3]
            dx = abs(r1-r2) + abs(g1-g2) + abs(b1-b2)
            r1, g1, b1 = tile.getpixel((tx, ty-1))[:3]
            r2, g2, b2 = tile.getpixel((tx, ty+1))[:3]
            dy = abs(r1-r2) + abs(g1-g2) + abs(b1-b2)
            if dx + dy > 150:
                edge_count += 1
    features['edge_density'] = edge_count / max(n, 1) * 100
    
    return features

def score_tiles(image_path, grid_size, challenge_type):
    """Score each tile for the given challenge type."""
    img = Image.open(image_path)
    w, h = img.size
    tw, th = w // grid_size, h // grid_size
    
    results = []
    for row in range(grid_size):
        for col in range(grid_size):
            tile_id = row * grid_size + col
            tile = img.crop((col * tw, row * th, (col + 1) * tw, (row + 1) * th))
            features = analyze_tile(tile)
            score = compute_score(features, challenge_type)
            results.append({
                'id': tile_id,
                'row': row, 'col': col,
                'features': {k: round(v, 2) for k, v in features.items()},
                'score': round(score, 2)
            })
    
    results.sort(key=lambda x: -x['score'])
    return results

def compute_score(f, challenge_type):
    """Compute match score based on challenge type."""
    ct = challenge_type.lower()
    
    # Pedestrian crossings / crosswalks / zebra crossings
    if any(kw in ct for kw in ['crosswalk', 'pedestrian crossing', 'zebra', 'crossing']):
        stripe_score = f['stripe_contrast'] * 8
        bright_score = f['bright_row_pct'] * 1.5
        edge_score = f['edge_density'] * 0.5
        # Penalize very dark or very bright tiles (not crossings)
        if f['brightness'] < 60 or f['brightness'] > 220:
            stripe_score *= 0.3
        return stripe_score + bright_score + edge_score
    
    # Traffic lights
    if any(kw in ct for kw in ['traffic light']):
        signal_score = (f['warm_pct'] + f['yellow_pct'] + f['red_pct'] + f['green_bright_pct']) * 2
        struct_score = f['dark_bottom_pct'] * 0.5 + f['dark_pole_pct'] * 0.8
        # Penalize very bright (sky-only) tiles
        if f['brightness'] > 200:
            signal_score *= 0.3
        return signal_score + struct_score
    
    # Buses
    if any(kw in ct for kw in ['bus', 'buses']):
        # Buses are large warm/yellow/red rectangular objects
        vehicle_score = (f['warm_pct'] + f['yellow_pct']) * 2.5
        edge_score = f['edge_density'] * 0.8  # buses have distinct edges
        # Penalize very dark tiles
        if f['brightness'] < 70:
            vehicle_score *= 0.2
        return vehicle_score + edge_score
    
    # Stairs / staircases
    if any(kw in ct for kw in ['stair', 'steps']):
        # Horizontal lines/edges + vertical structure
        stripe_score = f['stripe_contrast'] * 6
        edge_score = f['edge_density'] * 1.0
        return stripe_score + edge_score
    
    # Bridges
    if any(kw in ct for kw in ['bridge', 'bridges']):
        # Strong horizontal + vertical edges, water below
        edge_score = f['edge_density'] * 1.5
        stripe_score = f['stripe_contrast'] * 4
        # Dark bottom could be water
        water_score = f['dark_bottom_pct'] * 0.3
        return edge_score + stripe_score + water_score
    
    # Fire hydrants
    if any(kw in ct for kw in ['fire hydrant', 'hydrant']):
        # Red/orange small object + dark base
        red_score = (f['red_pct'] + f['warm_pct']) * 3
        struct_score = f['dark_bottom_pct'] * 0.5
        edge_score = f['edge_density'] * 0.5
        return red_score + struct_score + edge_score
    
    # Chimneys
    if any(kw in ct for kw in ['chimney', 'chimneys']):
        # Vertical dark structure on rooftop
        edge_score = f['edge_density'] * 1.0
        pole_score = f['dark_pole_pct'] * 1.0
        # Top portion should have edges (chimney top), bottom less so
        return edge_score + pole_score
    
    # General fallback: edge density + warm colors
    return f['edge_density'] * 0.5 + f['warm_pct'] * 0.5

def main():
    if len(sys.argv) < 4:
        print(json.dumps({'error': 'Usage: captcha-analyzer.py <image> <grid> <challenge_type>'}))
        sys.exit(1)
    
    image_path = sys.argv[1]
    grid_size = int(sys.argv[2])
    challenge_type = sys.argv[3]
    
    results = score_tiles(image_path, grid_size, challenge_type)
    
    # Determine threshold: pick tiles with score > 30% of max
    max_score = max(r['score'] for r in results) if results else 0
    threshold = max_score * 0.4  # 40% of max score
    selected = [r['id'] for r in results if r['score'] > threshold and r['score'] > 20]
    selected.sort()
    
    output = {
        'challenge_type': challenge_type,
        'grid_size': grid_size,
        'max_score': round(max_score, 2),
        'threshold': round(threshold, 2),
        'selected_tiles': selected,
        'tiles': results
    }
    print(json.dumps(output))

if __name__ == '__main__':
    main()
