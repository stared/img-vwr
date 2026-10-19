use super::*;

/// The tempdir must outlive the service — dropping it deletes the db.
fn service() -> (tempfile::TempDir, FaceService) {
    let dir = tempfile::tempdir().unwrap();
    let svc = FaceService::new(dir.path().join("cache"), &dir.path().join("faces.db")).unwrap();
    (dir, svc)
}

/// A unit vector along one axis — orthogonal axes are distinct people.
fn axis(i: usize) -> Arc<Vec<f32>> {
    let mut v = vec![0.0f32; 4];
    v[i] = 1.0;
    Arc::new(v)
}

fn install_clusters(svc: &FaceService, clusters: &[(&str, usize)]) {
    *svc.last_clusters.lock().unwrap() = clusters
        .iter()
        .map(|(id, ax)| LastCluster {
            id: id.to_string(),
            name: None,
            vectors: vec![axis(*ax); 4],
            photos: Vec::new(),
        })
        .collect();
}

fn person(id: &str, photos: &[&str]) -> PersonCluster {
    PersonCluster {
        id: id.into(),
        name: None,
        cover: String::new(),
        chips: Vec::new(),
        photos: photos.iter().map(|p| p.to_string()).collect(),
        solo: Vec::new(),
        few: Vec::new(),
        background: Vec::new(),
        implied: Vec::new(),
    }
}

#[test]
fn reclustering_keeps_each_unnamed_persons_number() {
    let last: Vec<LastCluster> = [("1", vec!["a", "b", "c"]), ("2", vec!["x", "y"])]
        .into_iter()
        .map(|(id, photos)| LastCluster {
            id: id.into(),
            name: None,
            vectors: Vec::new(),
            photos: photos.into_iter().map(String::from).collect(),
        })
        .collect();
    // The order flipped and both grew; a third person is new.
    let mut out = vec![
        person("1", &["x", "y", "z", "w"]),
        person("2", &["a", "b", "c", "d"]),
        person("3", &["q", "r"]),
    ];
    keep_ordinals(&mut out, &last);
    let ids: Vec<&str> = out.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["2", "1", "3"]);
}

#[test]
fn a_name_sticks_to_vectors_and_leaves_with_them() {
    let (_dir, svc) = service();
    install_clusters(&svc, &[("1", 0), ("2", 1)]);

    // Naming saves exemplars; both fragments named alike share them.
    svc.rename("1", "Ania", 0.38).unwrap();
    let names: Vec<String> = svc.identities().unwrap().into_iter().map(|i| i.name).collect();
    assert_eq!(names, ["Ania"]);
    svc.rename("2", "Ania", 0.38).unwrap();
    let ania = &svc.identities().unwrap()[0];
    assert!(ania.exemplars.iter().any(|e| e[0] > 0.9));
    assert!(ania.exemplars.iter().any(|e| e[1] > 0.9));

    // Renaming one fragment away withdraws only ITS exemplars.
    svc.rename("2", "Kasia", 0.38).unwrap();
    let ids = svc.identities().unwrap();
    let ania = ids.iter().find(|i| i.name == "Ania").unwrap();
    assert!(ania.exemplars.iter().all(|e| e[0] > 0.9));
    let kasia = ids.iter().find(|i| i.name == "Kasia").unwrap();
    assert!(kasia.exemplars.iter().all(|e| e[1] > 0.9));

    // Clearing the last cluster of a name deletes the identity.
    svc.rename("1", "", 0.38).unwrap();
    svc.rename("2", "  ", 0.38).unwrap();
    assert!(svc.identities().unwrap().is_empty());
}

#[test]
fn renaming_an_unknown_cluster_is_an_error_not_a_panic() {
    let (_dir, svc) = service();
    assert!(svc.rename("7", "Ania", 0.38).is_err());
}
